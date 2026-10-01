# Engram: TypeScript + Hono server (web API + one MCP endpoint), React web app built by Vite.
# The vault (markdown + git) and the SQLite index live under /srv/engram, mounted from the host.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# git: every vault write is a commit, so any change can be seen and undone.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
ENV NODE_ENV=production TZ=Asia/Kolkata PORT=8340 ENGRAM_ROOT=/srv/engram NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8340
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8340/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
