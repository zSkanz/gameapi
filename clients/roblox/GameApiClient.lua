--!strict
-- GameApiClient.lua  — ServerScriptService ModuleScript
-- Encodes the one rule that makes exactly-once real: the idempotency GUID is generated
-- ONCE per purchase, outside the retry loop, and reused on every attempt.
local HttpService = game:GetService("HttpService")

local GameApi = {}
GameApi.__index = GameApi

function GameApi.new(config)
	return setmetatable({
		baseUrl = config.baseUrl, -- "https://api.yourgame.com/v1"
		apiKey = config.apiKey, -- from a secret store, NOT hard-coded in client-facing code
		gameId = config.gameId, -- "sword-sim"
		maxRetries = config.maxRetries or 5,
	}, GameApi)
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

return GameApi
