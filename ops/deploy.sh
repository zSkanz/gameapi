#!/usr/bin/env bash
# PRODUCTION REFERENCE — health-gated rolling deploy via docker-rollout.
# Usage: ./ops/deploy.sh <immutable-image-tag>
# The explicit `-f docker-compose.yml` skips docker-compose.override.yml (dev-only), so
# the API runs with API_REPLICAS replicas and NO published host port (Caddy fronts it).
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
export API_IMAGE_TAG="$TAG"

COMPOSE="docker compose -f docker-compose.yml --profile prod"

$COMPOSE pull api

# run migrations once (advisory-locked; backward-compatible expand/contract)
$COMPOSE run --rm --no-deps api node dist/migrate.js

# health-gated rolling replace of the api replicas (requires the docker-rollout plugin)
docker rollout -f docker-compose.yml api

# refresh the long-running services
$COMPOSE up -d --no-deps caddy redis postgres

# `up -d` does NOT pick up an edited Caddyfile: its contents are a read-only bind mount, not part
# of the config hash Compose uses to decide on recreation, and Caddy does not watch the file. So
# without this an updated Caddyfile — new security headers (frame-ancestors, HSTS), the
# X-Forwarded-For rewrite — silently keeps the previous boot's config. `caddy reload` applies the
# current file gracefully (no dropped connections). Tolerated if Caddy was just (re)created, since
# it already booted with the current file then.
$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile \
  || echo "deploy: caddy reload skipped (freshly started with current config)"

docker image prune -f
echo "deploy: ${TAG} live"
