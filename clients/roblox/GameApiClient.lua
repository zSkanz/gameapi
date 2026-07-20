--!strict
-- GameApiClient.lua  — ServerScriptService ModuleScript
-- Encodes the one rule that makes exactly-once real: the idempotency GUID is generated
-- ONCE per purchase, outside the retry loop, and reused on every attempt.
local HttpService = game:GetService("HttpService")

local GameApi = {}
GameApi.__index = GameApi

-- Funnel batching. A Roblox server gets ~500 HTTP requests per MINUTE for everything it does,
-- shared with the stock calls above — and a 6-step funnel across 30 onboarding players is 180
-- events. So funnel events are queued and flushed together, never sent one per call.
local FUNNEL_FLUSH_SIZE = 100 -- matches the server's batch cap
local FUNNEL_FLUSH_SECONDS = 20

function GameApi.new(config)
	local self = setmetatable({
		baseUrl = config.baseUrl, -- "https://api.yourgame.com/v1"
		apiKey = config.apiKey, -- from a secret store, NOT hard-coded in client-facing code
		gameId = config.gameId, -- "sword-sim"
		maxRetries = config.maxRetries or 5,
		_funnelQueue = {}, -- funnelName -> { kind, steps, events }
		-- Last step time per (funnel, player, session), so msSincePrev measures the PLAYER, not
		-- our flush interval. Dropped on server hop -> nil -> excluded from the average.
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

	return self
end

-- Core request with retry + backoff. idemKey (if given) is REUSED across all attempts.
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
				return parsed.data -- success
			end
			local code = parsed.error and parsed.error.code
			-- retriable server-side conditions: back off and retry with the SAME idemKey
			if code == "SERVICE_UNAVAILABLE" or code == "RATE_LIMITED" then
				task.wait(0.5 * attempt) -- linear backoff
			else
				error(("GameApi error %s: %s"):format(tostring(code), tostring(parsed.error and parsed.error.message)))
			end
		else
			-- network/timeout: the mutation MAY have applied; retry SAME idemKey -> server dedupes
			task.wait(0.5 * attempt)
		end
	end
	error("GameApi request failed after " .. self.maxRetries .. " attempts")
end

-- Server startup: guarantee the key exists (idempotent seed of stock AND max).
function GameApi:getOrCreate(stockKey, expectedStock)
	local path = ("/games/%s/stock/%s/get"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { expectedStock = expectedStock })
end

-- Purchase: generate the idempotency key ONCE, before any retry.
function GameApi:decrease(stockKey, amount)
	local idemKey = HttpService:GenerateGUID(false) -- ONCE per logical purchase
	local path = ("/games/%s/stock/%s/decrease"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { amount = amount }, idemKey) -- SAME idemKey every retry
end

-- Admin restock / correction (positive caps at the record's max; negative clamps at 0).
function GameApi:adjust(stockKey, delta)
	local idemKey = HttpService:GenerateGUID(false)
	local path = ("/games/%s/stock/%s/adjust"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { delta = delta }, idemKey)
end

-- Admin set per-record ceiling (clamps stock down if the new ceiling is below current stock).
function GameApi:setMax(stockKey, targetStockMax)
	local idemKey = HttpService:GenerateGUID(false) -- ONCE per logical call
	local path = ("/games/%s/stock/%s/set-max"):format(self.gameId, HttpService:UrlEncode(stockKey))
	return self:_request("POST", path, { targetStockMax = targetStockMax }, idemKey)
end

-- ============================================================ funnels
-- Deliberately the same shape as Roblox's own AnalyticsService, so the two read alike:
--   AnalyticsService:LogOnboardingFunnelStepEvent(player, step, stepName, customFields)
--   GameApi:logOnboardingFunnelStep            (player, step, stepName, customFields)
-- The difference is that these are QUEUED, not sent — see FUNNEL_FLUSH_SIZE above for why.

function GameApi:_queueFunnelStep(funnelName, kind, player, sessionId, step, stepName, customFields)
	local bucket = self._funnelQueue[funnelName]
	if not bucket then
		bucket = { kind = kind, steps = {}, events = {} }
		self._funnelQueue[funnelName] = bucket
	end

	-- Step names ride along on every flush rather than being registered separately: that is what
	-- makes the funnel auto-create, and it makes renaming a step self-healing.
	if stepName then
		bucket.steps[step] = stepName
	end

	local userId = typeof(player) == "Instance" and player.UserId or player
	local now = DateTime.now().UnixTimestamp
	local runKey = ("%s|%d|%s"):format(funnelName, userId, sessionId or "")
	local prev = self._lastStepAt[runKey]
	self._lastStepAt[runKey] = now

	table.insert(bucket.events, {
		playerId = userId,
		step = step,
		stepName = stepName,
		sessionId = sessionId,
		at = now,
		-- nil when we never saw the previous step (server hop). The server excludes nil from the
		-- average rather than counting it as zero, which would drag every number down.
		msSincePrev = prev and math.max(0, (now - prev) * 1000) or nil,
		customFields = customFields,
	})

	if #bucket.events >= FUNNEL_FLUSH_SIZE then
		self:flushFunnels()
	end
end

--- The one unnamed funnel per experience. Mirrors LogOnboardingFunnelStepEvent.
function GameApi:logOnboardingFunnelStep(player, step, stepName, customFields)
	self:_queueFunnelStep("onboarding", "onboarding", player, nil, step, stepName, customFields)
end

--- A named, repeatable funnel. Mirrors LogFunnelStepEvent. Max 10 per game, as on Roblox.
--- funnelSessionId distinguishes one pass from another; omit it for once-per-player funnels.
function GameApi:logFunnelStep(player, funnelName, funnelSessionId, step, stepName, customFields)
	self:_queueFunnelStep(funnelName, "custom", player, funnelSessionId, step, stepName, customFields)
end

--- Send everything queued. Called automatically on the timer, at the size cap, and at shutdown.
function GameApi:flushFunnels()
	for funnelName, bucket in pairs(self._funnelQueue) do
		if #bucket.events > 0 then
			-- Take the batch BEFORE the request: a retry inside _request must not resend events
			-- that were queued while it was in flight.
			local events = bucket.events
			bucket.events = {}

			local steps = {}
			for i = 1, #bucket.steps do
				steps[i] = bucket.steps[i] or ("Step " .. i)
			end

			local path = ("/games/%s/funnel/log"):format(self.gameId)
			-- No Idempotency-Key: the server dedupes on (funnel, player, session, step), so a
			-- retried batch is a no-op. That is why _request's retry loop is safe here.
			local ok, err = pcall(function()
				self:_request("POST", path, {
					funnelName = funnelName,
					kind = bucket.kind,
					steps = #steps > 0 and steps or nil,
					events = events,
				})
			end)

			if not ok then
				-- Analytics must never break the game. Drop the batch and say so; the next flush
				-- carries on. The alternative — requeueing forever — turns a bad deploy into an
				-- unbounded memory leak on a live server.
				warn(("[GameApi] funnel flush failed for %s, dropped %d events: %s")
					:format(funnelName, #events, tostring(err)))
			end
		end
	end
end

return GameApi
