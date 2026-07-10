#!/usr/bin/env bash
# PRODUCTION REFERENCE — health-gated rolling deploy via docker-rollout.
# Usage: ./ops/deploy.sh <immutable-image-tag>
# Expand/contract migrations mean a code rollback never needs a schema rollback:
#   rollback = ./ops/deploy.sh <previous-tag>
set -euo pipefail

TAG="${1:?usage: deploy.sh <image-tag>}"
export API_IMAGE_TAG="$TAG"

docker compose pull api outbox-consumer

# run migrations once (advisory-locked; backward-compatible expand/contract)
docker compose run --rm --no-deps api node dist/migrate.js

# health-gated rolling replace of the api replicas (requires the docker-rollout plugin)
docker rollout -f docker-compose.yml api

# refresh the long-running singletons
docker compose up -d --no-deps outbox-consumer caddy redis postgres

docker image prune -f
echo "deploy: ${TAG} live"
