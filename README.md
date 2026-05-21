# Vortex API

API-only Vortex deployment for VPS, Docker, Nixpacks, or Cloudflare Workers.

## Routes

- `GET /health`
- `GET /api/vortex/movie/{tmdbId}`
- `GET /api/vortex/tv/{tmdbId}/{season}/{episode}`
- `GET /api/vortex/anime/{id}/{episode}/{sub|dub}`
- `GET /api/stream?url={encodedUrl}` fallback proxy

## Docker

```bash
docker build -t vortex-api .
docker run -p 8787:8787 -e PORT=8787 vortex-api
```

## Docker Compose

```bash
docker compose up -d --build
```

## Nixpacks

Nixpacks can deploy this folder directly. It runs:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
node dist/server.js
```

## DNS

For VPS/Node deployments, point a real configured domain you control, such as
`api.basementx.xyz`, to the server, then reverse proxy to port `8787`.
Do not use an unconfigured placeholder domain in frontend runtime config.
