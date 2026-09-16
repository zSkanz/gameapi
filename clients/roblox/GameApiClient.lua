--!strict
--[[
	GameApiClient — ServerScriptService ModuleScript

	One module for everything the API does: limited stock, serial numbers, and funnel analytics.
	SERVER ONLY. In a LocalScript the API key ships to every player's machine.

	Two rules are encoded here rather than left to the caller, because both are the kind of thing
	that looks fine in testing and loses money in production:

	  1. A stock mutation's idempotency GUID is generated ONCE, outside the retry loop, and reused
	     on every attempt. That is what makes a dropped response safe to retry — the server
	     recognises the replay instead of selling the unit twice.

	  2. Funnel events are QUEUED, never sent one per call. A Roblox server gets roughly 500 HTTP
	     requests per MINUTE for everything it does, and a 6-step funnel across 30 onboarding
	     players is 180 events on its own.
]]

--[[ Services ]]

local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")

--[[ Types ]]
--[[
	Written against the NEW type solver. Annotations are advisory in Luau — a mismatch shows up in
	Studio's Script Analysis, it does not stop the module loading — but a clean --!strict pass is
	what lets a real mistake in calling code stand out.

	Methods are declared `GameApi.name(self: GameApi, ...)` rather than `GameApi:name(...)`: with
	the colon form `self` cannot be annotated, so the solver infers a different partial shape for
	it from each method body and every cross-method call becomes a type error.
]]

export type Config = {
	baseUrl: string, -- "https://api.yourgame.com/v1"
	apiKey: string, -- from the API keys tab; a secret, never a literal in shared code
	gameId: string, -- "sword-sim"
	maxRetries: number?, -- default 5
}

--- Roblox reads only these three keys and ignores anything else. So do we.
export type CustomFields = {
	CustomField01: string?,
	CustomField02: string?,
	CustomField03: string?,
}

--- Options for a serial issuer. All optional: {} gives an infinite counter starting at 1.
export type SerialOptions = {
	start: number?, -- first number handed out, default 1
	max: number?, -- highest number, nil = infinite
	stockKey: string?, -- link to a stock key: each issue also decrements it
}

--- A player, or a raw UserId. Both accepted everywhere a player is taken.
export type PlayerRef = Player | number

-- RequestAsync types Method as a literal union, so a plain `string` does not satisfy it.
type HttpMethod = "GET" | "POST"

type FunnelEvent = {
	playerId: number,
	step: number,
	sessionId: string?,
	at: number,
	msSincePrev: number?,
	customFields: CustomFields?,
}

type FunnelBucket = {
	kind: string,
	steps: { [number]: string },
	maxStep: number,
	events: { FunnelEvent },
}

--[[ Constants ]]

local FUNNEL_FLUSH_SIZE = 100 -- matches the server's per-request batch cap
local FUNNEL_FLUSH_SECONDS = 20
local RETRY_BACKOFF_SECONDS = 0.5 -- linear: 0.5s, 1.0s, 1.5s...

--[[ Module ]]

local GameApi = {}
GameApi.__index = GameApi

type Fields = {
	baseUrl: string,
	apiKey: string,
	gameId: string,
	maxRetries: number,
	_funnelQueue: { [string]: FunnelBucket },
	_lastStepAt: { [string]: number },
}

-- typeof(setmetatable(...)) rather than the setmetatable<> type function: same type under the new
-- solver, and the old one (still selectable in Studio) understands it too.
export type GameApi = typeof(setmetatable({} :: Fields, GameApi))

--[[ Constructor ]]

function GameApi.new(config: Config): GameApi
	local self: GameApi = setmetatable({
		baseUrl = config.baseUrl,
		apiKey = config.apiKey,
		gameId = config.gameId,
		maxRetries = config.maxRetries or 5,
		_funnelQueue = {},
		-- Last step time per (funnel, player, session), so msSincePrev measures the PLAYER rather
		-- than our flush interval. Absent on a server hop -> nil -> excluded from the average.
		_lastStepAt = {},
	}, GameApi)

	task.spawn(function()
		while true do
			task.wait(FUNNEL_FLUSH_SECONDS)
			pcall(function()
				self:flushFunnels()
			end)
		end
	end)

	-- Without this every server shutdown silently drops its tail — which is exactly the moment a
	-- player finishes onboarding and leaves.
	game:BindToClose(function()
		pcall(function()
			self:flushFunnels()
		end)
	end)

	-- Flush BEFORE forgetting them, or the last step of the session leaves with the player.
	Players.PlayerRemoving:Connect(function(player)
		pcall(function()
			self:flushFunnels()
			self:_forgetPlayer(player.UserId)
		end)
	end)

	return self
end

--[[ Private Methods ]]

--- Core request with retry + backoff. idemKey, if given, is REUSED across every attempt.
function GameApi._request(self: GameApi, method: HttpMethod, path: string, body: any?, idemKey: string?): any
	local url = self.baseUrl .. path
	-- Annotated to the engine's own header type: a table literal would be inferred as exactly
	-- { string } values, which does not match { [string]: string | Secret }.
	local headers: { [string]: string | Secret } = { ["Content-Type"] = "application/json", ["X-Api-Key"] = self.apiKey }
	if idemKey then
		headers["Idempotency-Key"] = idemKey
	end
	local payload = body and HttpService:JSONEncode(body) or nil

	for attempt = 1, self.maxRetries do
		-- Annotated because pcall returns (boolean, ...) and the analyser will not infer the second
		-- value through the closure — without these it reports "Function only returns 1 value".
		local ok: boolean, res: any = pcall(function()
			return HttpService:RequestAsync({ Url = url, Method = method, Headers = headers, Body = payload })
		end)

		if ok and res.Body ~= nil and res.Body ~= "" then
			local parsed = HttpService:JSONDecode(res.Body)
			if parsed.ok then
				return parsed.data
			end
			local code = parsed.error and parsed.error.code
			-- Retriable server-side conditions: back off and retry with the SAME idemKey.
			if code == "SERVICE_UNAVAILABLE" or code == "RATE_LIMITED" then
				task.wait(RETRY_BACKOFF_SECONDS * attempt)
			else
				-- `details` carries WHICH field failed, and dropping it made a validation error
				-- read as a bare "Invalid" with nothing to act on. Include it: for a rejected
				-- funnel batch the difference is between "something is wrong" and
				-- "funnelName must be 1-64 characters".
				local detail = ""
				if parsed.error and parsed.error.details then
					local okEncode, encoded = pcall(HttpService.JSONEncode, HttpService, parsed.error.details)
					if okEncode then
						detail = " " .. encoded
					end
				end
				error(
					("GameApi error %s: %s%s"):format(
						tostring(code),
						tostring(parsed.error and parsed.error.message),
						detail
					)
				)
			end
		else
			-- Network/timeout: the mutation MAY have applied. Retrying with the same idemKey is
			-- what makes that safe — the server dedupes it.
			task.wait(RETRY_BACKOFF_SECONDS * attempt)
		end
	end
	error("GameApi request failed after " .. self.maxRetries .. " attempts")
end

--- Queue one funnel step. Both public funnel methods land here.
function GameApi._queueFunnelStep(
	self: GameApi,
	funnelName: string,
	kind: string,
	player: PlayerRef,
	sessionId: string?,
	step: number,
	stepName: string?,
	customFields: CustomFields?
)
	local bucket = self._funnelQueue[funnelName]
	if not bucket then
		-- maxStep is tracked explicitly rather than read back with `#steps`: steps arrive in
		-- whatever order the game reaches them, so `steps` is a table with holes, and Luau's length
		-- operator is only defined for sequences — on {[1]=..,[3]=..} it may answer 1 or 3. Reading
		-- it would silently drop the names of every step past the first hole.
		bucket = { kind = kind, steps = {}, maxStep = 0, events = {} }
		self._funnelQueue[funnelName] = bucket
	end

	-- Step names ride along on every flush rather than being registered by a separate call: that
	-- is what makes the funnel auto-create, and it makes renaming a step self-healing.
	if stepName then
		bucket.steps[step] = stepName
	end
	if step > bucket.maxStep then
		bucket.maxStep = step
	end

	-- Narrowed with a branch rather than `and/or`: under --!strict the analyser cannot see through
	-- that idiom and flags .UserId on the number side of the union.
	local userId: number
	if typeof(player) == "Instance" then
		userId = (player :: Player).UserId
	else
		userId = player :: number
	end

	-- Milliseconds, not seconds. UnixTimestamp is integer seconds, so a delta computed from it is
	-- always a multiple of 1000 — and this feeds a column whose whole job is timing a transition
	-- that is often under a second.
	local nowMs = DateTime.now().UnixTimestampMillis
	local runKey = ("%s|%d|%s"):format(funnelName, userId, sessionId or "")
	local prev = self._lastStepAt[runKey]
	self._lastStepAt[runKey] = nowMs

	table.insert(bucket.events, {
		playerId = userId,
		step = step,
		-- stepName is deliberately NOT repeated here: it already rides in the batch's `steps`
		-- array, and on a 59-step funnel repeating it across 100 events is 4.5 KB of the 16 KB
		-- body limit. The server accepts it either way.
		sessionId = sessionId,
		at = math.floor(nowMs / 1000), -- the server takes unix SECONDS
		-- nil when we never saw the previous step. The server excludes nil from the average rather
		-- than counting it as zero, which would drag every number down.
		msSincePrev = prev and math.max(0, nowMs - prev) or nil,
		customFields = customFields,
	})

	if #bucket.events >= FUNNEL_FLUSH_SIZE then
		self:flushFunnels()
	end
end

--- Drop a player's step timings once they are gone.
---
--- Without this `_lastStepAt` grows for the whole life of the server: one entry per
--- (funnel, player, session), never removed. A busy server churning players for hours accumulates
--- them without limit, and every entry is dead weight the moment the player leaves — someone who
--- rejoins lands on a different server and starts a new run anyway.
function GameApi._forgetPlayer(self: GameApi, userId: number)
	local needle = ("|%d|"):format(userId)
	for key in pairs(self._lastStepAt) do
		if string.find(key, needle, 1, true) then
			self._lastStepAt[key] = nil
		end
	end
end

--[[ Public Methods — Stock ]]

--- Server startup: guarantee the key exists. Idempotent seed of both stock AND max.
function GameApi.getOrCreate(self: GameApi, stockKey: string, expectedStock: number): any
	local path = ("/games/%s/stock/%s/get"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { expectedStock = expectedStock })
end

--- Purchase. The idempotency key is generated ONCE here, before any retry can happen.
function GameApi.decrease(self: GameApi, stockKey: string, amount: number): any
	local idemKey = HttpService:GenerateGUID(false) -- ONCE per logical purchase
	local path = ("/games/%s/stock/%s/decrease"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { amount = amount }, idemKey) -- SAME idemKey every retry
end

--- Restock or correction. Positive caps at the record's max; negative clamps at 0.
function GameApi.adjust(self: GameApi, stockKey: string, delta: number): any
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/adjust"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { delta = delta }, idemKey)
end

--- Set the per-record ceiling. Lowering it clamps current stock down; raising it never refills.
function GameApi.setMax(self: GameApi, stockKey: string, targetStockMax: number): any
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/set-max"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { targetStockMax = targetStockMax }, idemKey)
end

--- Read one key's current stock and max. Pure read: never creates, 404s if the key is unknown.
--- Use getOrCreate at startup and this for display.
function GameApi.read(self: GameApi, stockKey: string): any
	local path = ("/games/%s/stock/%s"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("GET", path)
end

--- Read MANY keys in one request. Max 100 per call.
---
--- This is the one to reach for on a shop refresh: fifteen separate reads is fifteen requests
--- against a ~500/minute server budget, and this is one. Returns { items, missing } — keys that
--- do not exist come back in `missing` rather than failing the whole call.
function GameApi.batchRead(self: GameApi, stockKeys: { string }): any
	local path = ("/games/%s/stock/batch"):format(self.gameId)
	return self:_request("POST", path, { stockKeys = stockKeys })
end

--- Every stock key registered for this game, paginated (limit max 1000).
function GameApi.listStock(self: GameApi, limit: number?, offset: number?): any
	local path = ("/games/%s/stock?limit=%d&offset=%d"):format(self.gameId, limit or 100, offset or 0)
	return self:_request("GET", path)
end

--[[ Public Methods — Serials ]]
--[[
	Unique sequential numbers: edition numbers, ticket numbers, "you are owner #14".

	Three modes, chosen by what you pass to getOrCreateSerial:
	  infinite      max = nil, stockKey = nil   -> counts up from start forever
	  capped        max set                     -> start..max, then exhausted
	  stock-linked  stockKey set                -> each issue also decrements that stock, so
	                                               "hand out a number" and "consume a unit" can
	                                               never disagree — they are one transaction.
]]

--- Create or read the issuer. Idempotent, so call it at server start like getOrCreate.
--- opts = { start = 1, max = nil, stockKey = nil }
function GameApi.getOrCreateSerial(self: GameApi, serialKey: string, opts: SerialOptions?): any
	-- Read through a non-optional local. Assigning back into `opts` leaves its declared type
	-- SerialOptions?, so every field access below still reads as possibly-nil.
	local o: SerialOptions = opts or {}
	local path = ("/games/%s/serial/%s/get"):format(self.gameId, HttpService:UrlEncode(serialKey))
	return self:_request("POST", path, {
		start = o.start or 1,
		max = o.max,
		stockKey = o.stockKey,
	})
end

--- Hand out the next number. Atomic and exactly-once.
---
--- The idempotency key is generated ONCE here, before any retry, for the same reason decrease()
--- does it: a dropped response must replay the number already issued rather than burn a second
--- one. Two players can never receive the same edition number.
--- Raises SERIAL_EXHAUSTED once the cap or the linked stock runs out.
function GameApi.issueSerial(self: GameApi, serialKey: string): any
	local idemKey = HttpService:GenerateGUID(false) -- ONCE per logical issue
	local path = ("/games/%s/serial/%s/issue"):format(self.gameId, HttpService:UrlEncode(serialKey))
	return self:_request("POST", path, nil, idemKey) -- SAME idemKey every retry
end

--- Read an issuer without issuing: start, next, max, issued, remaining, linked stockKey.
function GameApi.readSerial(self: GameApi, serialKey: string): any
	local path = ("/games/%s/serial/%s"):format(self.gameId, HttpService:UrlEncode(serialKey))
	return self:_request("GET", path)
end

--- Every serial issuer for this game, paginated (limit max 1000).
function GameApi.listSerials(self: GameApi, limit: number?, offset: number?): any
	local path = ("/games/%s/serial?limit=%d&offset=%d"):format(self.gameId, limit or 100, offset or 0)
	return self:_request("GET", path)
end

--[[ Public Methods — Funnels ]]
--[[
	Deliberately the same shape as Roblox's own AnalyticsService, so the two read alike:
	  AnalyticsService:LogOnboardingFunnelStepEvent(player, step, stepName, customFields)
	  GameApi           :logOnboardingFunnelStep  (player, step, stepName, customFields)
	The difference is that these QUEUE rather than send — see the Constants block for why.
]]

--- The one unnamed funnel per experience. Mirrors LogOnboardingFunnelStepEvent.
function GameApi.logOnboardingFunnelStep(self: GameApi, player: PlayerRef, step: number, stepName: string?, customFields: CustomFields?)
	self:_queueFunnelStep("onboarding", "onboarding", player, nil, step, stepName, customFields)
end

--- A named, repeatable funnel. Mirrors LogFunnelStepEvent. Max 10 per game, as on Roblox.
--- funnelSessionId ties one attempt together; omit it for a once-per-player funnel.
function GameApi.logFunnelStep(
	self: GameApi,
	player: PlayerRef,
	funnelName: string,
	funnelSessionId: string?,
	step: number,
	stepName: string?,
	customFields: CustomFields?
)
	self:_queueFunnelStep(funnelName, "custom", player, funnelSessionId, step, stepName, customFields)
end

--- Every funnel this game has logged, with its step count and last event time.
function GameApi.listFunnels(self: GameApi): any
	local path = ("/games/%s/funnel"):format(self.gameId)
	return self:_request("GET", path)
end

--- Send everything queued. Runs on the timer, at the size cap, on player leave, and at shutdown.
--- Safe to call by hand; a flush with nothing queued does nothing.
function GameApi.flushFunnels(self: GameApi)
	for funnelName, bucket in pairs(self._funnelQueue) do
		if #bucket.events > 0 then
			-- Take the batch BEFORE the request: a retry inside _request must not resend events
			-- that were queued while it was in flight.
			local events = bucket.events
			bucket.events = {}

			local steps = {}
			for i = 1, bucket.maxStep do
				steps[i] = bucket.steps[i] or ("Step " .. i)
			end

			local path = ("/games/%s/funnel/log"):format(self.gameId)
			-- No Idempotency-Key: the server dedupes on (funnel, player, session, step), so a
			-- retried batch is a no-op. That is what makes _request's retry loop safe here.
			local ok, err = pcall(function()
				self:_request("POST", path, {
					funnelName = funnelName,
					kind = bucket.kind,
					steps = bucket.maxStep > 0 and steps or nil,
					events = events,
				})
			end)

			if not ok then
				-- Analytics must never break the game. Drop the batch and say so; the next flush
				-- carries on. Requeueing forever would turn a bad deploy into an unbounded memory
				-- leak on a live server.
				warn(
					("[GameApi] funnel flush failed for %s, dropped %d events: %s"):format(
						funnelName,
						#events,
						tostring(err)
					)
				)
			end
		end
	end
end

return GameApi
