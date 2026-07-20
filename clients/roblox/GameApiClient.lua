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

--[[ Shapes ]]
--[[
	Documented rather than declared as Luau `export type`s: this file is pasted straight into
	Studio, and a type-syntax slip is not a warning there — the module fails to load outright.

	Config          { baseUrl: string, apiKey: string, gameId: string, maxRetries: number? }
	CustomFields    { CustomField01: string?, CustomField02: string?, CustomField03: string? }
	                Only those three keys exist, exactly as on Roblox; anything else is ignored.
	FunnelEvent     { playerId, step, stepName?, sessionId?, at, msSincePrev?, customFields? }
	Bucket          { kind, steps: {[step]: name} (SPARSE — see maxStep), maxStep, events }
]]

--[[ Constants ]]

local FUNNEL_FLUSH_SIZE = 100 -- matches the server's per-request batch cap
local FUNNEL_FLUSH_SECONDS = 20
local RETRY_BACKOFF_SECONDS = 0.5 -- linear: 0.5s, 1.0s, 1.5s...

--[[ Module ]]

local GameApi = {}
GameApi.__index = GameApi

--[[ Constructor ]]

function GameApi.new(config)
	local self = setmetatable({
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
function GameApi:_request(method, path, body, idemKey)
	local url = self.baseUrl .. path
	local headers = { ["Content-Type"] = "application/json", ["X-Api-Key"] = self.apiKey }
	if idemKey then
		headers["Idempotency-Key"] = idemKey
	end
	local payload = body and HttpService:JSONEncode(body) or nil

	for attempt = 1, self.maxRetries do
		local ok, res = pcall(function()
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
				error(("GameApi error %s: %s"):format(tostring(code), tostring(parsed.error and parsed.error.message)))
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
function GameApi:_queueFunnelStep(funnelName, kind, player, sessionId, step, stepName, customFields)
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

	local userId = typeof(player) == "Instance" and player.UserId or player
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
		stepName = stepName,
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
function GameApi:_forgetPlayer(userId)
	local needle = ("|%d|"):format(userId)
	for key in pairs(self._lastStepAt) do
		if string.find(key, needle, 1, true) then
			self._lastStepAt[key] = nil
		end
	end
end

--[[ Public Methods — Stock ]]

--- Server startup: guarantee the key exists. Idempotent seed of both stock AND max.
function GameApi:getOrCreate(stockKey, expectedStock)
	local path = ("/games/%s/stock/%s/get"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { expectedStock = expectedStock })
end

--- Purchase. The idempotency key is generated ONCE here, before any retry can happen.
function GameApi:decrease(stockKey, amount)
	local idemKey = HttpService:GenerateGUID(false) -- ONCE per logical purchase
	local path = ("/games/%s/stock/%s/decrease"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { amount = amount }, idemKey) -- SAME idemKey every retry
end

--- Restock or correction. Positive caps at the record's max; negative clamps at 0.
function GameApi:adjust(stockKey, delta)
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/adjust"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { delta = delta }, idemKey)
end

--- Set the per-record ceiling. Lowering it clamps current stock down; raising it never refills.
function GameApi:setMax(stockKey, targetStockMax)
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/set-max"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { targetStockMax = targetStockMax }, idemKey)
end

--[[ Public Methods — Funnels ]]
--[[
	Deliberately the same shape as Roblox's own AnalyticsService, so the two read alike:
	  AnalyticsService:LogOnboardingFunnelStepEvent(player, step, stepName, customFields)
	  GameApi           :logOnboardingFunnelStep  (player, step, stepName, customFields)
	The difference is that these QUEUE rather than send — see the Constants block for why.
]]

--- The one unnamed funnel per experience. Mirrors LogOnboardingFunnelStepEvent.
function GameApi:logOnboardingFunnelStep(player, step, stepName, customFields)
	self:_queueFunnelStep("onboarding", "onboarding", player, nil, step, stepName, customFields)
end

--- A named, repeatable funnel. Mirrors LogFunnelStepEvent. Max 10 per game, as on Roblox.
--- funnelSessionId ties one attempt together; omit it for a once-per-player funnel.
function GameApi:logFunnelStep(player, funnelName, funnelSessionId, step, stepName, customFields)
	self:_queueFunnelStep(funnelName, "custom", player, funnelSessionId, step, stepName, customFields)
end

--- Send everything queued. Runs on the timer, at the size cap, on player leave, and at shutdown.
--- Safe to call by hand; a flush with nothing queued does nothing.
function GameApi:flushFunnels()
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
