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
const SERVICE_NAME = "VortexWorker";
const GIT_COMMIT = "034a2c5";
const DEPLOYED_AT = "2026-05-21T00:00:00.000Z";
const SOURCE_BLACKLIST = new Set(["fsharetv.co", "lmscript.xyz"]);
const ALLOWED_ORIGINS = new Set([
  "https://basementx.xyz",
  "https://www.basementx.xyz",
  "https://basement-90p.pages.dev",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]);
const BASEMENT_HOME = "https://basementx.xyz/";

type Env = {
  VORTEX_API_TOKEN?: string;
};

function corsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get("origin");
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://basementx.xyz";
  return {
    "access-control-allow-origin": allowedOrigin,
    vary: "Origin",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Range, Content-Type, Authorization, X-Api-Token, X-Token",
    "access-control-expose-headers":
      "Content-Length, Content-Range, Content-Type, X-Proxy-Service, X-Proxy-Route, X-Upstream-Host, X-Upstream-Status, X-Upstream-Content-Type, X-Proxy-Error, X-Rewritten-Urls, X-Vortex-Proxy-Route, X-Vortex-Upstream-Host, X-Vortex-Upstream-Status, X-Vortex-Proxy-Error, X-Vortex-Rewritten-Urls",
  };
}

function streamLog(payload: Record<string, unknown>): void {
  console.log("[stream-debug]", {
    proxyService: SERVICE_NAME,
    proxyPurpose: "hls-cors-header-proxy",
    gitCommit: GIT_COMMIT,
    ...payload,
  });
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);

    const accessResponse = guardAccess(request, url, env);
    if (accessResponse) return accessResponse;

    if (url.pathname === "/__version") {
      return json({
        service: SERVICE_NAME,
        gitCommit: GIT_COMMIT,
        deployedAt: DEPLOYED_AT,
        environment: "production",
        routes: [
          "/api/stream",
          "/m3u8-proxy",
          "/api/lightning/movie/{tmdbId}",
          "/api/lightning/tv/{tmdbId}/{season}/{episode}",
          "/api/vortex/movie/{tmdbId}",
          "/api/vortex/tv/{tmdbId}/{season}/{episode}",
        ],
      }, 200, {}, request);
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: SERVICE_NAME,
        gitCommit: GIT_COMMIT,
        deployedAt: DEPLOYED_AT,
        note: "API-only Worker for Vortex. Prefer direct upstream stream URLs; /api/stream is a fallback.",
        routes: [
          "/api/vortex/movie/{tmdbId}",
          "/api/vortex/tv/{tmdbId}/{season}/{episode}",
          "/api/vortex/anime/{id}/{episode}/{sub|dub}",
          "/api/movie/{tmdbId}",
          "/api/tv/{tmdbId}/{season}/{episode}",
          "/api/stream?url={encodedUrl}",
        ],
      }, 200, {}, request);
    }

    if (url.pathname.startsWith("/api/vortex/")) {
      return handleVortex(request, url);
    }

    if (url.pathname.startsWith("/api/lightning/") || url.pathname.startsWith("/api/subtitles/")) {
      return handleGoatApi(request, url);
    }

    const sourceAlias = matchSourceAlias(url.pathname);
    if (sourceAlias) {
      const next = new URL(url.toString());
      next.pathname = sourceAlias.rewrittenPath;
      next.searchParams.set("source", sourceAlias.source);
      return handleVortex(request, next);
    }

    if (url.pathname.startsWith("/api/movie/")) {
      return handleVortex(request, rewriteAlias(url, "/api/movie/", "/api/vortex/movie/"));
    }

    if (url.pathname.startsWith("/api/tv/")) {
      return handleVortex(request, rewriteAlias(url, "/api/tv/", "/api/vortex/tv/"));
    }

    if (url.pathname.startsWith("/api/stream") || url.pathname.startsWith("/m3u8-proxy")) {
      return handleStream(request);
    }

    return json({ ok: false, error: "Not found" }, 404, {}, request);
  },
};

function guardAccess(request: Request, url: URL, env: Env): Response | null {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
  const isNavigation = request.headers.get("sec-fetch-mode") === "navigate" || acceptsHtml;
  const isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  const token = request.headers.get("x-token") ?? request.headers.get("x-api-token") ?? url.searchParams.get("token");

  if (env.VORTEX_API_TOKEN && token === env.VORTEX_API_TOKEN) return null;

  if (origin) {
    if (ALLOWED_ORIGINS.has(origin)) return null;
    return json({ ok: false, error: "Origin not allowed" }, 403, {}, request);
  }

  if (referer) {
    try {
      if (ALLOWED_ORIGINS.has(new URL(referer).origin)) return null;
    } catch {
      // Fall through to the direct-browser handling below.
    }
  }

  if (isNavigation && !isLocalHost) {
    return Response.redirect(BASEMENT_HOME, 302);
  }

  if (env.VORTEX_API_TOKEN) {
    return json({ ok: false, error: "Token required" }, 401, {}, request);
  }

  return null;
}

function rewriteAlias(url: URL, from: string, to: string): URL {
  const next = new URL(url.toString());
  next.pathname = next.pathname.replace(from, to);
  return next;
}

async function handleGoatApi(request: Request, url: URL): Promise<Response> {
  const upstream = new URL(url.pathname + url.search, GOAT_API_BASE);
  upstream.searchParams.delete("token");

  streamLog({
    stage: "worker:goat-request",
    origin: request.headers.get("origin"),
    route: url.pathname,
    targetHostname: upstream.hostname,
  });

  let response = await fetch(upstream.toString(), {
    method: request.method,
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (response.status === 429 && url.pathname.startsWith("/api/lightning/")) {
    streamLog({
      stage: "worker:goat-retry",
      origin: request.headers.get("origin"),
      route: url.pathname,
      upstreamStatus: response.status,
      retryDelayMs: 5500,
    });
    await new Promise((resolve) => setTimeout(resolve, 5500));
    response = await fetch(upstream.toString(), {
      method: request.method,
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept: "application/json,text/plain,*/*",
      },
    });
  }

  streamLog({
    stage: "worker:goat-response",
    origin: request.headers.get("origin"),
    route: url.pathname,
    upstreamStatus: response.status,
  });

  const contentType = response.headers.get("content-type");
  const headers: Record<string, string> = {
    ...corsHeaders(request),
    "x-proxy-service": SERVICE_NAME,
    "x-upstream-host": upstream.hostname,
    "x-upstream-status": String(response.status),
    "x-upstream-content-type": contentType ?? "",
    "x-vortex-upstream-host": upstream.hostname,
    "x-vortex-upstream-status": String(response.status),
  };
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

async function handleVortex(request: Request, url: URL): Promise<Response> {
  const segs = url.pathname.replace(/^\/api\/vortex\/?/, "").split("/").filter(Boolean);
  const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl")) || 600, 30), 3600);
  const lang = normalizeLanguageParam(url.searchParams.get("lang"));
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

    return json(filterResultLanguage(data, lang), 200, {
      "x-cache": cached ? "HIT" : "MISS",
      "cache-control": `private, max-age=${ttl}`,
    }, request);
  } catch (error) {
    return json({ ok: false, source, error: String((error as Error).message ?? error) }, 502, {}, request);
  }
}

function normalizeLanguageParam(input: string | null): string | null {
  const clean = input?.trim();
  if (!clean || clean.toLowerCase() === "default") return "english";
  if (clean.toLowerCase() === "all") return null;
  return clean.toLowerCase();
}

function filterResultLanguage(data: VortexResult, lang: string | null): VortexResult {
  if (!lang) return data;

  const filterCaptions = (captions: VortexResult["primary"]["captions"] = []) =>
    captions.filter((caption) => caption.language?.toLowerCase().includes(lang));
  const streams = data.streams.map((stream) => ({
    ...stream,
    captions: filterCaptions(stream.captions),
  }));

  return {
    ...data,
    primary: streams[0] ?? { ...data.primary, captions: filterCaptions(data.primary.captions) },
    streams,
  };
}

function sanitizeSource(source: string | null): string {
  const clean = source?.trim().toLowerCase();
  if (!clean || clean === "default") return "vortex";
  return clean.replace(/[^a-z0-9-]/g, "");
}

async function handleStream(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("missing url", { status: 400, headers: corsHeaders(request) });

  let upstream: URL;
  try {
    upstream = new URL(target);
  } catch {
    return new Response("bad url", { status: 400, headers: corsHeaders(request) });
  }

  if (SOURCE_BLACKLIST.has(upstream.hostname)) {
    return new Response("blocked host", {
      status: 451,
      headers: {
        ...corsHeaders(request),
        "x-proxy-service": SERVICE_NAME,
        "x-proxy-error": "worker-blacklist",
        "x-upstream-host": upstream.hostname,
        "x-vortex-proxy-error": "worker-blacklist",
        "x-vortex-upstream-host": upstream.hostname,
      },
    });
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

  const safeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([key]) => ["Referer", "Origin", "Range", "Accept"].includes(key)),
  );

  streamLog({
    stage: "worker:stream-request",
    origin: request.headers.get("origin"),
    route: url.pathname,
    targetHostname: upstream.hostname,
    parsedHeaders: safeHeaders,
    proxyRoute: url.pathname.startsWith("/m3u8-proxy") ? "/m3u8-proxy" : "/api/stream",
  });

  const response = await fetch(upstream.toString(), { method: request.method, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const isManifest =
    /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(upstream.pathname + upstream.search);

  const responseHeaders: Record<string, string> = {
    ...corsHeaders(request),
    "x-proxy-service": SERVICE_NAME,
    "x-proxy-route": url.pathname,
    "x-upstream-host": upstream.hostname,
    "x-upstream-status": String(response.status),
    "x-upstream-content-type": contentType,
    "x-vortex-proxy-route": url.pathname,
    "x-vortex-upstream-host": upstream.hostname,
    "x-vortex-upstream-status": String(response.status),
  };
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
    const value = response.headers.get(header);
    if (value) responseHeaders[header] = value;
  }

  streamLog({
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
    responseHeaders["x-proxy-error"] = "upstream";
    responseHeaders["x-vortex-proxy-error"] = "upstream";
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  if (!isManifest) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }

  const text = await response.text();
  responseHeaders["content-type"] = "application/vnd.apple.mpegurl";
  delete responseHeaders["content-length"];
  const rewritten = rewriteManifest(text, upstream, request.url);
  responseHeaders["x-rewritten-urls"] = String(rewritten.rewrittenUrls);
  responseHeaders["x-vortex-rewritten-urls"] = String(rewritten.rewrittenUrls);
  streamLog({
    stage: "worker:manifest-rewrite",
    route: url.pathname,
    targetHostname: upstream.hostname,
    rewrittenUrls: rewritten.rewrittenUrls,
    firstBodyChars: text.slice(0, 200),
  });
  return new Response(rewritten.body, {
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

function rewriteManifest(manifest: string, upstream: URL, requestUrl: string): { body: string; rewrittenUrls: number } {
  const proxyBase = new URL(requestUrl);
  const ref = proxyBase.searchParams.get("ref");
  const origin = proxyBase.searchParams.get("origin");
  const originalHeaders = proxyBase.searchParams.get("headers");
  const token = proxyBase.searchParams.get("token");
  proxyBase.search = "";
  let rewrittenUrls = 0;

  const wrap = (absoluteUrl: string) => {
    const params = new URLSearchParams({ url: absoluteUrl });
    if (ref) params.set("ref", ref);
    if (origin) params.set("origin", origin);
    if (originalHeaders) params.set("headers", originalHeaders);
    if (token) params.set("token", token);
    rewrittenUrls += 1;
    return `${proxyBase.origin}${proxyBase.pathname}?${params.toString()}`;
  };

  const body = manifest
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

  return { body, rewrittenUrls };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}, request?: Request): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(request),
      ...extra,
    },
  });
}
