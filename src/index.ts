import { withCache } from "./lib/cache";
import {
  resolveVortexAnime,
  resolveVortexMovie,
  resolveVortexTv,
  type VortexResult,
} from "./lib/scrapers/vortex";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type",
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
        note: "API-only Worker. Prefer direct upstream stream URLs; /api/stream is a fallback.",
        routes: [
          "/api/vortex/movie/{tmdbId}",
          "/api/vortex/tv/{tmdbId}/{season}/{episode}",
          "/api/vortex/anime/{id}/{episode}/{sub|dub}",
          "/api/stream?url={encodedUrl}",
        ],
      });
    }

    if (url.pathname.startsWith("/api/vortex/")) {
      return handleVortex(url);
    }

    if (url.pathname.startsWith("/api/stream")) {
      return handleStream(request);
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

async function handleVortex(url: URL): Promise<Response> {
  const segs = url.pathname.replace(/^\/api\/vortex\/?/, "").split("/").filter(Boolean);
  const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl")) || 600, 30), 3600);

  try {
    const { data, cached } = await withCache<VortexResult>(
      "vortex-stream",
      segs.join("/"),
      ttl,
      async () => {
        if (segs[0] === "movie") {
          if (!segs[1]) throw new Error("Missing tmdbId");
          return resolveVortexMovie(segs[1]);
        }

        if (segs[0] === "tv") {
          if (!segs[1] || !segs[2] || !segs[3]) throw new Error("Missing tmdbId/season/episode");
          return resolveVortexTv(segs[1], segs[2], segs[3]);
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
    return json({ ok: false, source: "vortex", error: String((error as Error).message ?? error) }, 502);
  }
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
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept: "*/*",
    Referer: ref || `${upstream.protocol}//${upstream.host}/`,
    Origin: origin || `${upstream.protocol}//${upstream.host}`,
  };
  if (range) headers.Range = range;

  const response = await fetch(upstream.toString(), { method: request.method, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const isManifest =
    /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(upstream.pathname + upstream.search);

  const responseHeaders: Record<string, string> = { ...CORS_HEADERS };
  for (const header of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
    const value = response.headers.get(header);
    if (value) responseHeaders[header] = value;
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

function rewriteManifest(manifest: string, upstream: URL, requestUrl: string): string {
  const proxyBase = new URL(requestUrl);
  const ref = proxyBase.searchParams.get("ref");
  const origin = proxyBase.searchParams.get("origin");
  proxyBase.search = "";

  const wrap = (absoluteUrl: string) => {
    const params = new URLSearchParams({ url: absoluteUrl });
    if (ref) params.set("ref", ref);
    if (origin) params.set("origin", origin);
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
