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
# X-Forwarded-For rewrite — silently keeps the previous boot's config.
#
# Validate FIRST: a Caddyfile with a typo must fail the deploy loudly, not be swallowed while the
# old config keeps serving (which a bare `reload || echo` would do — it hides a real config error
# behind a benign-looking "skipped" message).
$COMPOSE exec -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Then reload, retrying only for the transient case where Caddy was just recreated and is not
# answering yet. A reload of a valid config is a graceful no-op if already current.
reloaded=0
for attempt in 1 2 3; do
  if $COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    reloaded=1
    break
  fi
  echo "deploy: caddy reload attempt ${attempt} failed; retrying in 2s"
  sleep 2
done
[ "$reloaded" = 1 ] || { echo "deploy: caddy reload FAILED — config is valid but Caddy did not accept it"; exit 1; }

docker image prune -f
echo "deploy: ${TAG} live"
