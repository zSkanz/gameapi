#!/usr/bin/env bash
# GameApi - quick setup (Linux / macOS / dev).
# Installs deps, prepares .env, and builds. For production the Docker image builds
# everything itself (see README) - this script is for a local dev clone.
set -euo pipefail
cd "$(dirname "$0")"

echo "============================================"
echo "  GameApi - quick setup"
echo "============================================"
echo

# --- prerequisites ---
command -v node >/dev/null 2>&1 || { echo "[ERROR] Node.js 20+ not found. Install from https://nodejs.org"; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "[ERROR] npm not found (comes with Node.js)."; exit 1; }
echo "Using Node $(node -v)"
echo

# --- 1) dependencies ---
echo "[1/3] Installing dependencies (npm install)..."
npm install
echo

# --- 2) .env ---
echo "[2/3] Preparing .env..."
if [ -f .env ]; then
  echo "  .env already exists - keeping it."
else
  cp .env.example .env
  echo "  .env created from .env.example - REMEMBER to set API_KEYS before running."
fi
echo

# --- 3) build ---
echo "[3/3] Building (npm run build)..."
npm run build
echo

echo "============================================"
echo "  Done! Next steps:"
echo "    - Local dev (needs Postgres + Redis):  npm run dev"
echo "    - Everything via Docker:               docker compose up --build"
echo "============================================"
