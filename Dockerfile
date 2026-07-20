# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Build-time only. The panel inlines clients/roblox/GameApiClient.lua with Vite's ?raw so the
# Client tab can hand it to you, which means the file has to exist when `vite build` runs — it
# never ships to the runtime stage. Omitting this fails ONLY in the container, where the missing
# import is a hard "Could not resolve" rather than anything a local build would show.
COPY clients ./clients
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# non-root
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER app
EXPOSE 3000
# default command runs the API; the outbox-consumer service overrides this
CMD ["node", "dist/server.js"]
