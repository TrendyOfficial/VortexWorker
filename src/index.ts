import { withCache } from "./lib/cache";
import {
  resolveVortexAnime,
  resolveVortexMovieBySource,
  resolveVortexMovie,
  resolveVortexTvBySource,
  resolveVortexTv,
  type VortexResult,
} from "./lib/scrapers/vortex";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const GOAT_API_BASE = "https://goatapi.imreallydagoatt.workers.dev";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type, Authorization, X-Api-Token",
  "access-control-expose-headers": "Content-Length, Content-Range",
};

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "vortex-api",
        note: "API-only Worker for Vortex. Prefer direct upstream stream URLs; /api/stream is a fallback.",
        routes: [
          "/api/vortex/movie/{tmdbId}",
          "/api/vortex/tv/{tmdbId}/{season}/{episode}",
          "/api/vortex/anime/{id}/{episode}/{sub|dub}",
          "/api/movie/{tmdbId}",
          "/api/tv/{tmdbId}/{season}/{episode}",
          "/api/stream?url={encodedUrl}",
        ],
      });
    }

    if (url.pathname.startsWith("/api/vortex/")) {
      return handleVortex(url);
    }

    if (url.pathname.startsWith("/api/lightning/") || url.pathname.startsWith("/api/subtitles/")) {
      return handleGoatApi(request, url);
    }

    const sourceAlias = matchSourceAlias(url.pathname);
    if (sourceAlias) {
      const next = new URL(url.toString());
      next.pathname = sourceAlias.rewrittenPath;
      next.searchParams.set("source", sourceAlias.source);
      return handleVortex(next);
    }

    if (url.pathname.startsWith("/api/movie/")) {
      return handleVortex(rewriteAlias(url, "/api/movie/", "/api/vortex/movie/"));
    }

    if (url.pathname.startsWith("/api/tv/")) {
      return handleVortex(rewriteAlias(url, "/api/tv/", "/api/vortex/tv/"));
    }

    if (url.pathname.startsWith("/api/stream") || url.pathname.startsWith("/m3u8-proxy")) {
      return handleStream(request);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

function rewriteAlias(url: URL, from: string, to: string): URL {
  const next = new URL(url.toString());
  next.pathname = next.pathname.replace(from, to);
  return next;
}

async function handleGoatApi(request: Request, url: URL): Promise<Response> {
  const upstream = new URL(url.pathname + url.search, GOAT_API_BASE);
  upstream.searchParams.delete("token");

  console.log("[stream-debug]", {
    stage: "worker:goat-request",
    origin: request.headers.get("origin"),
    route: url.pathname,
    targetHostname: upstream.hostname,
  });

  const response = await fetch(upstream.toString(), {
    method: request.method,
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json,text/plain,*/*",
    },
  });

  console.log("[stream-debug]", {
    stage: "worker:goat-response",
    origin: request.headers.get("origin"),
    route: url.pathname,
    upstreamStatus: response.status,
  });

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    "x-vortex-upstream-host": upstream.hostname,
    "x-vortex-upstream-status": String(response.status),
  };
  const contentType = response.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function matchSourceAlias(pathname: string): { source: string; rewrittenPath: string } | null {
  const segs = pathname.split("/").filter(Boolean);
  const source = sanitizeSource(segs[1] ?? null);
  if (segs[0] !== "api" || source === "vortex") return null;

  if (segs[2] === "movie" && segs[3]) {
    return { source, rewrittenPath: `/api/vortex/movie/${segs[3]}` };
  }

  if (segs[2] === "tv" && segs[3] && segs[4] && segs[5]) {
    return { source, rewrittenPath: `/api/vortex/tv/${segs[3]}/${segs[4]}/${segs[5]}` };
  }

  return null;
}

async function handleVortex(url: URL): Promise<Response> {
  const segs = url.pathname.replace(/^\/api\/vortex\/?/, "").split("/").filter(Boolean);
  const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl")) || 600, 30), 3600);
  const pathSource =
    segs[0] === "movie" ? segs[2] : segs[0] === "tv" ? segs[4] : undefined;
  const source = sanitizeSource(pathSource ?? url.searchParams.get("source"));

  try {
    const { data, cached } = await withCache<VortexResult>(
      "vortex-stream",
      `${source}:${segs.join("/")}`,
      ttl,
      async () => {
        if (segs[0] === "movie") {
          if (!segs[1]) throw new Error("Missing tmdbId");
          return source === "vortex" ? resolveVortexMovie(segs[1]) : resolveVortexMovieBySource(segs[1], source);
        }

        if (segs[0] === "tv") {
          if (!segs[1] || !segs[2] || !segs[3]) throw new Error("Missing tmdbId/season/episode");
          return source === "vortex"
            ? resolveVortexTv(segs[1], segs[2], segs[3])
            : resolveVortexTvBySource(segs[1], segs[2], segs[3], source);
        }

        if (segs[0] === "anime") {
          if (!segs[1] || !segs[2]) throw new Error("Missing id/episode");
          const type = segs[3] === "dub" ? "dub" : "sub";
          return resolveVortexAnime(segs[1], segs[2], type);
        }

        throw new Error("Use /api/vortex/movie/{id}, /api/vortex/tv/{id}/{season}/{episode}, or /api/vortex/anime/{id}/{episode}/{type}");
      },
    );

    return json(data, 200, {
      "x-cache": cached ? "HIT" : "MISS",
      "cache-control": `private, max-age=${ttl}`,
    });
  } catch (error) {
    return json({ ok: false, source, error: String((error as Error).message ?? error) }, 502);
  }
}

function sanitizeSource(source: string | null): string {
  const clean = source?.trim().toLowerCase();
  if (!clean || clean === "default") return "vortex";
  return clean.replace(/[^a-z0-9-]/g, "");
}

async function handleStream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("missing url", { status: 400, headers: CORS_HEADERS });

  let upstream: URL;
  try {
    upstream = new URL(target);
  } catch {
    return new Response("bad url", { status: 400, headers: CORS_HEADERS });
  }

  const range = request.headers.get("range");
  const ref = url.searchParams.get("ref");
  const origin = url.searchParams.get("origin");
  const providedHeaders = parseHeadersParam(url.searchParams.get("headers"));
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept: "*/*",
    Referer: ref || `${upstream.protocol}//${upstream.host}/`,
    Origin: origin || `${upstream.protocol}//${upstream.host}`,
    ...providedHeaders,
  };
  if (range) headers.Range = range;

  console.log("[stream-debug]", {
    stage: "worker:stream-request",
    origin: request.headers.get("origin"),
    route: url.pathname,
    targetHostname: upstream.hostname,
    parsedHeaders: Object.fromEntries(
      Object.entries(headers).filter(([key]) => ["Referer", "Origin", "Range"].includes(key)),
    ),
  });

  const response = await fetch(upstream.toString(), { method: request.method, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const isManifest =
    /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(upstream.pathname + upstream.search);

  const responseHeaders: Record<string, string> = {
    ...CORS_HEADERS,
    "x-vortex-proxy-route": url.pathname,
    "x-vortex-upstream-host": upstream.hostname,
    "x-vortex-upstream-status": String(response.status),
  };
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
    const value = response.headers.get(header);
    if (value) responseHeaders[header] = value;
  }

  console.log("[stream-debug]", {
    stage: "worker:stream-response",
    origin: request.headers.get("origin"),
    route: url.pathname,
    targetHostname: upstream.hostname,
    upstreamStatus: response.status,
    contentType,
    isManifest,
    errorSource: response.ok ? undefined : "upstream",
  });

  if (!response.ok) {
    responseHeaders["x-vortex-proxy-error"] = "upstream";
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  if (!isManifest) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const text = await response.text();
  responseHeaders["content-type"] = "application/vnd.apple.mpegurl";
  delete responseHeaders["content-length"];
  return new Response(rewriteManifest(text, upstream, request.url), {
    status: response.status,
    headers: responseHeaders,
  });
}

function parseHeadersParam(input: string | null): Record<string, string> {
  if (!input) return {};

  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function rewriteManifest(manifest: string, upstream: URL, requestUrl: string): string {
  const proxyBase = new URL(requestUrl);
  const ref = proxyBase.searchParams.get("ref");
  const origin = proxyBase.searchParams.get("origin");
  const originalHeaders = proxyBase.searchParams.get("headers");
  const token = proxyBase.searchParams.get("token");
  proxyBase.search = "";

  const wrap = (absoluteUrl: string) => {
    const params = new URLSearchParams({ url: absoluteUrl });
    if (ref) params.set("ref", ref);
    if (origin) params.set("origin", origin);
    if (originalHeaders) params.set("headers", originalHeaders);
    if (token) params.set("token", token);
    return `${proxyBase.pathname}?${params.toString()}`;
  };

  return manifest
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
          return `URI="${wrap(new URL(uri, upstream).toString())}"`;
        });
      }

      return wrap(new URL(trimmed, upstream).toString());
    })
    .join("\n");
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}
