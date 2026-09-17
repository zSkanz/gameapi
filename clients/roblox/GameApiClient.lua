--!strict
--[[
	GameApiClient — ServerScriptService ModuleScript

	One module for everything the API does: limited stock, serial numbers, funnel analytics, live
	configs, and public Roblox data (game stats, users, groups, badges, game passes) that HttpService
	cannot fetch.
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
	configPollSeconds: number?, -- how often live configs are checked for a new version; default 15, min 5
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

--- Shared by every config snapshot of one client: the latest published version and test overrides.
type ConfigState = {
	loaded: boolean,
	polling: boolean,
	version: number,
	values: { [string]: any },
	testing: { [string]: any },
	snapshots: { [any]: boolean }, -- weak keys: a snapshot nobody holds is collected
}

--[[ Constants ]]

local FUNNEL_FLUSH_SIZE = 100 -- matches the server's per-request batch cap
local FUNNEL_FLUSH_SECONDS = 20
local RETRY_BACKOFF_SECONDS = 0.5 -- linear: 0.5s, 1.0s, 1.5s...
local CONFIG_POLL_SECONDS = 15 -- a changed config reaches a server within this, plus the publish itself
local CONFIG_POLL_MIN_SECONDS = 5

--[[ Module ]]

local GameApi = {}
GameApi.__index = GameApi

type Fields = {
	baseUrl: string,
	apiKey: string,
	gameId: string,
	maxRetries: number,
	configPollSeconds: number,
	_funnelQueue: { [string]: FunnelBucket },
	_lastStepAt: { [string]: number },
	_config: ConfigState,
}

-- typeof(setmetatable(...)) rather than the setmetatable<> type function: same type under the new
-- solver, and the old one (still selectable in Studio) understands it too.
export type GameApi = typeof(setmetatable({} :: Fields, GameApi))

--[[ Config snapshots ]]
--[[
	Deliberately the same shape as Roblox's ConfigSnapshot, so moving between the two is renaming a
	service: GetValue, Refresh, UpdateAvailable, GetValueChangedSignal, Outdated. And the same rule:
	a snapshot never changes under you. A new version only marks it Outdated and fires
	UpdateAvailable; values move when YOU call Refresh — e.g. between rounds, not mid-fight.
]]

local ConfigSnapshot = {}
ConfigSnapshot.__index = ConfigSnapshot

type SnapshotFields = {
	Version: number,
	Outdated: boolean,
	UpdateAvailable: RBXScriptSignal,
	_state: ConfigState,
	_values: { [string]: any },
	_testing: { [string]: any },
	_updateEvent: BindableEvent,
	_changedEvents: { [string]: BindableEvent },
}

export type ConfigSnapshot = typeof(setmetatable({} :: SnapshotFields, ConfigSnapshot))

--- A private copy, so one snapshot's tables can be modified without touching another's.
local function copy(value: any): any
	if type(value) ~= "table" then
		return value
	end
	local out = {}
	for k, v in value do
		out[k] = copy(v)
	end
	return out
end

--- Structural equality, so re-downloading an unchanged JSON config fires no change signal.
local function deepEqual(a: any, b: any): boolean
	if type(a) ~= "table" or type(b) ~= "table" then
		return a == b
	end
	for k, v in a do
		if not deepEqual(v, b[k]) then
			return false
		end
	end
	for k in b do
		if a[k] == nil then
			return false
		end
	end
	return true
end

local function newSnapshot(state: ConfigState): ConfigSnapshot
	local updateEvent = Instance.new("BindableEvent")
	local snapshot: ConfigSnapshot = setmetatable({
		Version = state.version,
		Outdated = false,
		UpdateAvailable = updateEvent.Event,
		_state = state,
		_values = copy(state.values),
		_testing = copy(state.testing),
		_updateEvent = updateEvent,
		_changedEvents = {},
	}, ConfigSnapshot)
	state.snapshots[snapshot] = true
	return snapshot
end

--- The value for a key at this snapshot's version, or nil if the key does not exist.
function ConfigSnapshot.GetValue(self: ConfigSnapshot, key: string): any
	local testing = self._testing[key]
	if testing ~= nil then
		return testing
	end
	return self._values[key]
end

--- Fires with the new value when a Refresh changes this key.
function ConfigSnapshot.GetValueChangedSignal(self: ConfigSnapshot, key: string): RBXScriptSignal
	local event = self._changedEvents[key]
	if not event then
		event = Instance.new("BindableEvent")
		self._changedEvents[key] = event
	end
	return event.Event
end

--- Move this snapshot to the latest values (and test overrides), firing a signal per changed key.
function ConfigSnapshot.Refresh(self: ConfigSnapshot)
	local state = self._state
	local before = {}
	for key in self._changedEvents do
		before[key] = self:GetValue(key)
	end

	self._values = copy(state.values)
	self._testing = copy(state.testing)
	self.Version = state.version
	self.Outdated = false

	for key, event in self._changedEvents do
		local after = self:GetValue(key)
		if not deepEqual(before[key], after) then
			event:Fire(after)
		end
	end
end

function ConfigSnapshot._markOutdated(self: ConfigSnapshot)
	self.Outdated = true
	self._updateEvent:Fire()
end

--[[ Constructor ]]

function GameApi.new(config: Config): GameApi
	local self: GameApi = setmetatable({
		baseUrl = config.baseUrl,
		apiKey = config.apiKey,
		gameId = config.gameId,
		maxRetries = config.maxRetries or 5,
		configPollSeconds = math.max(CONFIG_POLL_MIN_SECONDS, config.configPollSeconds or CONFIG_POLL_SECONDS),
		_config = {
			loaded = false,
			polling = false,
			version = 0,
			values = {},
			testing = {},
			-- Cast: a weak-keyed table is still a map as far as callers are concerned.
			snapshots = setmetatable({}, { __mode = "k" }) :: any,
		},
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

--[[ Private Helpers ]]

--- "1,2,3" with every ID as an integer — tostring(1e10) would give "1e+10".
local function csvIds(ids: { number }): string
	local parts = {}
	for i, id in ids do
		parts[i] = ("%d"):format(id)
	end
	return table.concat(parts, ",")
end

--- Append a pagination cursor. Cursors are opaque base64-ish tokens, so they are URL-encoded.
local function withCursor(path: string, cursor: string?): string
	if cursor then
		return path .. "?cursor=" .. HttpService:UrlEncode(cursor)
	end
	return path
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

--[[ Public Methods — Roblox data ]]
--[[
	Public Roblox data a game server cannot read itself: HttpService refuses every roblox.com domain,
	so likes, visits, profiles, group info and badge stats have to come through the API. Works for
	ANY experience, user or group, not just this game's. Everything is cached server-side (60s for
	live stats, up to 10 minutes for profiles and groups), so polling faster returns the same data.
	A lookup for something Roblox does not have raises NOT_FOUND.
]]

--- Stats for up to 50 experiences by universe ID. Returns { items, missing }, where each item has
--- playing, visits, favorites, upVotes, downVotes, likeRatio (0..1), name, creator, iconUrl, url
--- and fetchedAt. Unknown IDs land in `missing` rather than failing the call.
function GameApi.getUniverses(self: GameApi, universeIds: { number }): any
	local path = ("/games/%s/roblox/universes?ids=%s"):format(self.gameId, csvIds(universeIds))
	return self:_request("GET", path)
end

--- One experience's stats — this game's own by default (game.GameId is its universe ID).
--- nil in an unpublished place, where game.GameId is 0, and for a universe Roblox does not know.
function GameApi.getGameInfo(self: GameApi, universeId: number?): any
	local id = universeId or game.GameId
	if id == 0 then
		return nil -- Studio on an unpublished place: there is no universe to ask about
	end
	local path = ("/games/%s/roblox/universes?ids=%d"):format(self.gameId, id)
	return self:_request("GET", path).items[1]
end

--- A place ID (the number in a roblox.com/games/<id> URL) -> its universe ID, or nil.
function GameApi.getUniverseIdFromPlace(self: GameApi, placeId: number): number?
	local path = ("/games/%s/roblox/places/%d/universe"):format(self.gameId, placeId)
	return self:_request("GET", path).universeId
end

--- An experience's badges with award statistics (awardedCount, pastDayAwardedCount), 100 per page.
--- Defaults to this game (empty in an unpublished place). Returns { items, nextCursor } — pass
--- nextCursor back for the next page.
function GameApi.getBadges(self: GameApi, universeId: number?, cursor: string?): any
	local id = universeId or game.GameId
	if id == 0 then
		return { items = {}, nextCursor = nil } -- unpublished place
	end
	local path = ("/games/%s/roblox/universes/%d/badges"):format(self.gameId, id)
	return self:_request("GET", withCursor(path, cursor))
end

--- An experience's game passes with price (Robux, nil when not for sale) and icon, 100 per page.
--- Defaults to this game (empty in an unpublished place). Returns { items, nextCursor }.
function GameApi.getGamePasses(self: GameApi, universeId: number?, cursor: string?): any
	local id = universeId or game.GameId
	if id == 0 then
		return { items = {}, nextCursor = nil } -- unpublished place
	end
	local path = ("/games/%s/roblox/universes/%d/game-passes"):format(self.gameId, id)
	return self:_request("GET", withCursor(path, cursor))
end

--- Up to 100 users by ID in one request. Returns { items, missing }; each item has userId,
--- username, displayName, hasVerifiedBadge, avatarUrl and profileUrl.
function GameApi.getUsers(self: GameApi, userIds: { number }): any
	local path = ("/games/%s/roblox/users?ids=%s"):format(self.gameId, csvIds(userIds))
	return self:_request("GET", path)
end

--- Up to 100 users by username (case-insensitive). Same items as getUsers plus requestedUsername;
--- names that match no account are listed in `missing`.
function GameApi.getUsersByUsername(self: GameApi, usernames: { string }): any
	local names = {}
	for i, name in usernames do
		names[i] = HttpService:UrlEncode(name)
	end
	local path = ("/games/%s/roblox/users/by-username?names=%s"):format(self.gameId, table.concat(names, ","))
	return self:_request("GET", path)
end

--- One full profile: getUsers' fields plus description, createdAt, isBanned, friends, followers
--- and following. Works for players who are not in this server.
function GameApi.getUser(self: GameApi, userId: number): any
	local path = ("/games/%s/roblox/users/%d"):format(self.gameId, userId)
	return self:_request("GET", path)
end

--- Every group a user is in, with role { roleId, name, rank }. Returns { userId, items }.
function GameApi.getUserGroups(self: GameApi, userId: number): any
	local path = ("/games/%s/roblox/users/%d/groups"):format(self.gameId, userId)
	return self:_request("GET", path)
end

--- One group: name, description, owner, memberCount, shout, publicEntryAllowed, iconUrl and roles
--- (ascending rank, each with memberCount).
function GameApi.getGroup(self: GameApi, groupId: number): any
	local path = ("/games/%s/roblox/groups/%d"):format(self.gameId, groupId)
	return self:_request("GET", path)
end

--[[ Public Methods — Live configs ]]
--[[
	Values you change from the panel (or a tool with a config:write key) without republishing:
	feature flags, prices, drop rates, event switches. Mirrors Roblox's ConfigService:

	  local config = api:getConfigAsync()
	  local bossHealth = config:GetValue("bossHealth")
	  config.UpdateAvailable:Connect(function() config:Refresh() end)
	  config:GetValueChangedSignal("bossHealth"):Connect(function(newValue) ... end)

	One background check per server every configPollSeconds (default 15), and it downloads the
	config only when the version changed. Needs a key with the config:read scope.
]]

--- Fetch the latest published config. Only the first call ever touches the network before
--- returning; later calls reuse what the background check keeps current.
function GameApi._loadConfig(self: GameApi): boolean
	local state = self._config
	local path = ("/games/%s/config?knownVersion=%d"):format(self.gameId, state.version)
	local data = self:_request("GET", path)
	state.loaded = true
	if data.changed and data.version ~= state.version then
		state.version = data.version
		state.values = data.entries or {}
		return true
	end
	return false
end

--- A snapshot of the live config. Yields on the first call; raises only if the config has never
--- loaded (wrap it in pcall with fallbacks if a game must start while the API is down). After
--- that, an unreachable API just means snapshots keep their last values.
function GameApi.getConfigAsync(self: GameApi): ConfigSnapshot
	local state = self._config
	if not state.loaded then
		self:_loadConfig()
	end

	if not state.polling then
		state.polling = true
		task.spawn(function()
			while true do
				task.wait(self.configPollSeconds)
				local ok, changed = pcall(self._loadConfig, self)
				if ok and changed then
					for snapshot in state.snapshots do
						(snapshot :: ConfigSnapshot):_markOutdated()
					end
				end
			end
		end)
	end

	return newSnapshot(state)
end

--- Override a key on THIS server only — for trying a value live or in Studio. Like a real update,
--- snapshots see it after Refresh (UpdateAvailable fires). Other servers are unaffected.
function GameApi.setConfigTestingValue(self: GameApi, key: string, value: any)
	self._config.testing[key] = value
	for snapshot in self._config.snapshots do
		(snapshot :: ConfigSnapshot):_markOutdated()
	end
end

--- Remove a testing override; the published value applies again after Refresh.
function GameApi.clearConfigTestingValue(self: GameApi, key: string)
	self._config.testing[key] = nil
	for snapshot in self._config.snapshots do
		(snapshot :: ConfigSnapshot):_markOutdated()
	end
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
