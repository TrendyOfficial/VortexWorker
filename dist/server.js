// src/server.ts
import { createServer } from "node:http";
import { Readable } from "node:stream";

// src/lib/cache.ts
var stores = /* @__PURE__ */ new Map();
function getCache(namespace) {
  let s = stores.get(namespace);
  if (!s) {
    s = /* @__PURE__ */ new Map();
    stores.set(namespace, s);
  }
  return {
    get(key) {
      const e = s.get(key);
      if (!e) return void 0;
      if (Date.now() > e.expires) {
        s.delete(key);
        return void 0;
      }
      return e.value;
    },
    set(key, value, ttlSeconds) {
      s.set(key, { value, expires: Date.now() + ttlSeconds * 1e3 });
    },
    stats() {
      let live = 0;
      const now = Date.now();
      for (const e of s.values()) if (e.expires > now) live++;
      return { entries: live };
    }
  };
}
async function withCache(namespace, key, ttl, loader) {
  const c = getCache(namespace);
  const hit = c.get(key);
  if (hit !== void 0) return { data: hit, cached: true };
  const data = await loader();
  c.set(key, data, ttl);
  return { data, cached: false };
}

// src/lib/scrapers/vertex.ts
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
async function fetchWithTimeout(url, init = {}) {
  const { timeout = 8e3, ...rest } = init;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { ...rest, signal: ctl.signal, headers: { "User-Agent": UA, Accept: "*/*", ...rest.headers || {} } });
  } finally {
    clearTimeout(t);
  }
}
async function withRetry(fn, attempts = 2, baseDelay = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}
var CONSUMET_BASES = [
  "https://api.consumet.org",
  "https://consumet-api-puce.vercel.app"
];
async function consumetGet(path) {
  let lastErr;
  for (const base of CONSUMET_BASES) {
    try {
      return await withRetry(async () => {
        const r = await fetchWithTimeout(`${base}${path}`, { timeout: 6500 });
        if (!r.ok) throw new Error(`consumet ${r.status}`);
        return r.json();
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
async function flixhqResolveByTmdb(kind, title, year, season, episode) {
  const search = await consumetGet(`/movies/flixhq/${encodeURIComponent(title)}`);
  const wantType = kind === "movie" ? "Movie" : "TV Series";
  const candidates = (search.results || []).filter((r) => (r.type ?? "").toLowerCase().includes(kind === "movie" ? "movie" : "tv"));
  const pick = candidates.find((c) => year && c.releaseDate?.startsWith(year)) || candidates[0];
  if (!pick) return null;
  const info = await consumetGet(`/movies/flixhq/info?id=${encodeURIComponent(pick.id)}`);
  const ep = kind === "movie" ? info.episodes?.[0] : info.episodes?.find((e) => String(e.season ?? "") === String(season) && String(e.number) === String(episode));
  if (!ep) return null;
  const servers = ["upcloud", "vidcloud"];
  for (const server2 of servers) {
    try {
      const data = await consumetGet(
        `/movies/flixhq/watch?episodeId=${encodeURIComponent(ep.id)}&mediaId=${encodeURIComponent(pick.id)}&server=${server2}`
      );
      const m3u8 = data.sources?.find((s) => s.isM3U8 || s.url?.includes(".m3u8"))?.url;
      if (!m3u8) continue;
      return {
        id: `flixhq-${server2}`,
        label: `FlixHQ (${server2})`,
        type: "hls",
        playlist: m3u8,
        captions: (data.subtitles || []).map((s, i) => ({
          id: `cap-${i}`,
          url: s.url,
          language: s.lang,
          type: s.url.endsWith(".srt") ? "srt" : "vtt"
        })),
        headers: data.headers,
        upstream: `consumet/flixhq/${server2}`
      };
    } catch {
    }
  }
  return null;
}
async function gogoResolve(idOrSlug, episode, type) {
  const search = await consumetGet(`/anime/gogoanime/${encodeURIComponent(idOrSlug)}`);
  const pick = (search.results || []).find((r) => type === "dub" ? /dub/i.test(r.title) : !/dub/i.test(r.title)) || (search.results || [])[0];
  if (!pick) return null;
  const info = await consumetGet(`/anime/gogoanime/info/${encodeURIComponent(pick.id)}`);
  const ep = info.episodes?.find((e) => String(e.number) === String(episode));
  if (!ep) return null;
  for (const server2 of ["gogocdn", "vidstreaming", "streamsb"]) {
    try {
      const data = await consumetGet(`/anime/gogoanime/watch/${encodeURIComponent(ep.id)}?server=${server2}`);
      const m3u8 = data.sources?.find((s) => s.isM3U8 || s.url?.includes(".m3u8"))?.url;
      if (!m3u8) continue;
      return {
        id: `gogo-${server2}`,
        label: `Gogoanime (${server2})`,
        type: "hls",
        playlist: m3u8,
        captions: [],
        headers: data.headers,
        upstream: `consumet/gogoanime/${server2}`
      };
    } catch {
    }
  }
  return null;
}
var TMDB_KEY = "3a68cdec21c0ca11a86e96fa7ee94a4c";
async function tmdbTitle(kind, id) {
  const r = await fetchWithTimeout(`https://api.themoviedb.org/3/${kind}/${id}?api_key=${TMDB_KEY}`, { timeout: 5e3 });
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  const j = await r.json();
  const title = j.title || j.name || "";
  const date = j.release_date || j.first_air_date || "";
  return { title, year: date ? date.slice(0, 4) : void 0 };
}
async function resolveMovie(tmdbId) {
  const start = Date.now();
  const meta = await tmdbTitle("movie", tmdbId);
  if (!meta.title) throw new Error("Movie not found on TMDB");
  const stream = await flixhqResolveByTmdb("movie", meta.title, meta.year);
  if (!stream) throw new Error("Vertex could not resolve a stream for this title");
  return {
    ok: true,
    source: "vertex",
    kind: "movie",
    params: { id: tmdbId },
    primary: stream,
    streams: [stream],
    ms: Date.now() - start
  };
}
async function resolveTv(tmdbId, season, episode) {
  const start = Date.now();
  const meta = await tmdbTitle("tv", tmdbId);
  if (!meta.title) throw new Error("Show not found on TMDB");
  const stream = await flixhqResolveByTmdb("tv", meta.title, meta.year, season, episode);
  if (!stream) throw new Error(`Vertex could not resolve S${season}E${episode}`);
  return {
    ok: true,
    source: "vertex",
    kind: "tv",
    params: { id: tmdbId, season, episode },
    primary: stream,
    streams: [stream],
    ms: Date.now() - start
  };
}
async function resolveAnime(idOrSlug, episode, type) {
  const start = Date.now();
  const stream = await gogoResolve(idOrSlug, episode, type);
  if (!stream) throw new Error("Vertex could not resolve this anime episode");
  return {
    ok: true,
    source: "vertex",
    kind: "anime",
    params: { id: idOrSlug, episode, type },
    primary: stream,
    streams: [stream],
    ms: Date.now() - start
  };
}

// src/lib/vortex-db.ts
var MEMORY_KEY = "vortex-db:entries";
function readEnv(name) {
  const runtime = globalThis;
  return runtime.process?.env?.[name];
}
var UPSTASH_URL = readEnv("VORTEX_DB_REST_URL");
var UPSTASH_TOKEN = readEnv("VORTEX_DB_REST_TOKEN");
var memoryEntries = [];
function hasUpstash() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}
async function upstash(path) {
  const response = await fetch(`${UPSTASH_URL}/${path}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`
    }
  });
  if (!response.ok) throw new Error(`Vortex DB storage ${response.status}`);
  const data = await response.json();
  return data.result;
}
async function readEntries() {
  if (!hasUpstash()) return memoryEntries;
  const raw = await upstash(`get/${MEMORY_KEY}`);
  if (!raw) return [];
  return JSON.parse(raw);
}
async function resolveEntry(kind, tmdbId, season, episode) {
  const entries = await readEntries();
  const match = entries.find((entry) => {
    if (entry.kind !== kind || entry.tmdbId !== tmdbId) return false;
    if (kind === "movie") return true;
    return entry.season === season && entry.episode === episode;
  });
  if (!match) {
    return {
      ok: false,
      source: "vortex-db",
      kind,
      missing: true,
      placeholder: {
        label: kind === "movie" ? `Movie ${tmdbId}` : `S${season}:E${episode}`,
        pattern: "- - - ----"
      }
    };
  }
  const isHls = /\.m3u8(\?|$)/i.test(match.url);
  const primary = isHls ? {
    id: "vortex-db",
    label: `Vortex DB ${match.quality}`,
    type: "hls",
    playlist: match.url,
    captions: match.captions ?? []
  } : {
    id: "vortex-db",
    label: `Vortex DB ${match.quality}`,
    type: "file",
    qualities: {
      [match.quality]: { type: "mp4", url: match.url }
    },
    captions: match.captions ?? []
  };
  return {
    ok: true,
    source: "vortex-db",
    kind,
    primary,
    streams: [primary]
  };
}

// src/lib/scrapers/vortex.ts
var VIDZEE_BASE = "https://player.vidzee.wtf";
var VIDZEE_KEY_URL = "https://core.vidzee.wtf/api-key";
var VIDZEE_KEY_SECRET = "4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c";
var ENCRYPT_API_BASE = "https://enc-dec.app/api";
var VIDLINK_API_BASE = "https://vidlink.pro/api/b";
var VIDLINK_HEADERS = {
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
var UA2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var VORTEX_SERVERS = [
  { id: "vortex-togi", label: "Vortex Togi", sr: "0" },
  { id: "vortex-achilles", label: "Vortex Achilles", sr: "3" },
  { id: "vortex-nflix", label: "Vortex Nflix", sr: "4" },
  { id: "vortex-drag", label: "Vortex Drag", sr: "5" }
];
async function fetchWithTimeout2(url, init = {}) {
  const { timeout = 8e3, ...rest } = init;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, {
      ...rest,
      signal: ctl.signal,
      headers: {
        "User-Agent": UA2,
        Accept: "application/json,text/plain,*/*",
        ...rest.headers || {}
      }
    });
  } finally {
    clearTimeout(t);
  }
}
function b64ToBytes(input) {
  const raw = atob(input.replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
async function decryptApiKey(input) {
  try {
    const bytes = b64ToBytes(input);
    if (bytes.length <= 28) return "";
    const iv = bytes.slice(0, 12);
    const tag = bytes.slice(12, 28);
    const encrypted = bytes.slice(28);
    const payload = new Uint8Array(encrypted.length + tag.length);
    payload.set(encrypted, 0);
    payload.set(tag, encrypted.length);
    const keyHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(VIDZEE_KEY_SECRET)
    );
    const key = await crypto.subtle.importKey("raw", keyHash, { name: "AES-GCM" }, false, [
      "decrypt"
    ]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      payload
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return "";
  }
}
async function decryptStreamUrl(input, apiKey) {
  if (!input || !apiKey) return "";
  try {
    const decoded = atob(input);
    const [ivInput, encryptedInput] = decoded.split(":");
    if (!ivInput || !encryptedInput) return "";
    const keyBytes = new TextEncoder().encode(apiKey.padEnd(32, "\0").slice(0, 32));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
      "decrypt"
    ]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: toArrayBuffer(b64ToBytes(ivInput)) },
      key,
      toArrayBuffer(b64ToBytes(encryptedInput))
    );
    let bytes = new Uint8Array(decrypted);
    const padding = bytes[bytes.length - 1];
    if (padding > 0 && padding <= 16) bytes = bytes.slice(0, -padding);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
function normalizeCaptions(tracks) {
  return (tracks ?? []).reduce((captions, track, index) => {
    if (!track.url) return captions;
    captions.push({
      id: `${track.lang ?? "caption"}-${index}`,
      url: track.url,
      language: track.lang ?? "unknown",
      type: track.url.endsWith(".srt") ? "srt" : "vtt"
    });
    return captions;
  }, []);
}
function normalizeVidlinkCaptions(captions) {
  return (captions ?? []).reduce((acc, caption, index) => {
    if (!caption.url) return acc;
    acc.push({
      id: caption.id ?? `caption-${index}`,
      url: caption.url,
      language: caption.language ?? "unknown",
      type: caption.type === "srt" ? "srt" : "vtt"
    });
    return acc;
  }, []);
}
async function getVidzeeKey() {
  const res = await fetchWithTimeout2(VIDZEE_KEY_URL, {
    timeout: 5e3,
    headers: {
      Referer: `${VIDZEE_BASE}/`,
      Origin: VIDZEE_BASE
    }
  });
  if (!res.ok) return "";
  return decryptApiKey(await res.text());
}
function serverUrl(kind, id, sr, season, episode) {
  const url = new URL("/api/server", VIDZEE_BASE);
  url.searchParams.set("id", id);
  url.searchParams.set("sr", sr);
  if (kind === "tv") {
    url.searchParams.set("ss", season ?? "1");
    url.searchParams.set("ep", episode ?? "1");
  }
  return url.toString();
}
async function resolveVidzeeServer(kind, id, apiKey, server2, season, episode) {
  try {
    const res = await fetchWithTimeout2(serverUrl(kind, id, server2.sr, season, episode), {
      timeout: 6500,
      headers: {
        Referer: `${VIDZEE_BASE}/embed/${kind}/${id}`,
        Origin: VIDZEE_BASE
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error || !data.url?.length) return null;
    const urls = await Promise.all(data.url.map((source) => decryptStreamUrl(source.link, apiKey)));
    const playlist = urls.find(Boolean);
    if (!playlist) return null;
    return {
      id: server2.id,
      label: server2.label,
      type: "hls",
      playlist,
      captions: normalizeCaptions(data.tracks),
      headers: {
        ...data.headers ?? {},
        Referer: `${VIDZEE_BASE}/embed/${kind}/${id}`,
        Origin: VIDZEE_BASE
      },
      upstream: `vortex/vidzee/${server2.sr}`
    };
  } catch {
    return null;
  }
}
async function resolveVidzee(kind, id, season, episode) {
  const apiKey = await getVidzeeKey();
  if (!apiKey) return [];
  const settled = await Promise.all(
    VORTEX_SERVERS.map((server2) => resolveVidzeeServer(kind, id, apiKey, server2, season, episode))
  );
  return settled.filter((stream) => !!stream);
}
async function encryptVidlinkId(id) {
  const url = new URL(`${ENCRYPT_API_BASE}/enc-vidlink`);
  url.searchParams.set("text", id);
  const res = await fetchWithTimeout2(url.toString(), { timeout: 5e3 });
  if (!res.ok) return "";
  const data = await res.json();
  return data.result ?? "";
}
async function resolveVidlink(kind, id, season, episode) {
  try {
    const encryptedId = await encryptVidlinkId(id);
    if (!encryptedId) return [];
    const url = kind === "movie" ? `${VIDLINK_API_BASE}/movie/${encryptedId}?multiLang=0` : `${VIDLINK_API_BASE}/tv/${encryptedId}/${season}/${episode}?multiLang=0`;
    const res = await fetchWithTimeout2(url, {
      timeout: 6500,
      headers: {
        Referer: "https://vidlink.pro/",
        Origin: "https://vidlink.pro"
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const stream = data.stream;
    if (!stream) return [];
    if (stream.type === "hls" && stream.playlist) {
      return [
        {
          id: "vortex-link",
          label: "Vortex Link",
          type: "hls",
          playlist: stream.playlist,
          captions: normalizeVidlinkCaptions(stream.captions),
          headers: { ...VIDLINK_HEADERS, ...stream.headers ?? {} },
          upstream: "vortex/link"
        }
      ];
    }
    if (stream.type === "file" && stream.qualities && Object.keys(stream.qualities).length > 0) {
      return [
        {
          id: "vortex-link",
          label: "Vortex Link",
          type: "file",
          qualities: stream.qualities,
          captions: normalizeVidlinkCaptions(stream.captions),
          headers: { ...VIDLINK_HEADERS, ...stream.headers ?? {} },
          upstream: "vortex/link"
        }
      ];
    }
    return [];
  } catch {
    return [];
  }
}
async function timed(promise, timeout, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeout);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function firstNonEmptyStream(resolvers) {
  const pending = resolvers.map(
    (resolver) => resolver().then((streams) => uniqueStreams(streams)).catch(() => [])
  );
  const settled = [];
  while (pending.length > 0) {
    const indexed = pending.map(
      (promise, index2) => promise.then((streams2) => ({ index: index2, streams: streams2 }))
    );
    const { index, streams } = await Promise.race(indexed);
    pending.splice(index, 1);
    settled.push(streams);
    if (streams.length > 0) return streams;
  }
  return uniqueStreams(settled.flat());
}
function uniqueStreams(streams) {
  const seen = /* @__PURE__ */ new Set();
  return streams.filter((stream) => {
    const key = stream.playlist ?? JSON.stringify(stream.qualities ?? {});
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function fromDbStream(stream) {
  return {
    ...stream,
    captions: stream.captions ?? [],
    upstream: "vortex/db"
  };
}
async function withVertexFallback(streams, fallback) {
  if (streams.length >= 2) return streams;
  try {
    const result = await fallback();
    return uniqueStreams([
      ...streams,
      ...result.streams?.length ? result.streams : result.primary ? [result.primary] : []
    ]);
  } catch {
    return streams;
  }
}
async function resolveVortexMovie(tmdbId) {
  const start = Date.now();
  const db = await resolveEntry("movie", tmdbId);
  if (db.ok) {
    const streams2 = db.streams.map(fromDbStream);
    return {
      ok: true,
      source: "vortex",
      kind: "movie",
      params: { id: tmdbId },
      primary: streams2[0],
      streams: streams2,
      ms: Date.now() - start
    };
  }
  const [vidzeeStreams, linkStreams] = await Promise.all([
    timed(resolveVidzee("movie", tmdbId), 7e3, []),
    timed(resolveVidlink("movie", tmdbId), 7e3, [])
  ]);
  let streams = uniqueStreams([...vidzeeStreams, ...linkStreams]);
  streams = await withVertexFallback(streams, () => resolveMovie(tmdbId));
  if (streams.length === 0) throw new Error("Vortex could not resolve a stream for this movie");
  return {
    ok: true,
    source: "vortex",
    kind: "movie",
    params: { id: tmdbId },
    primary: streams[0],
    streams,
    ms: Date.now() - start
  };
}
async function resolveVortexTv(tmdbId, season, episode) {
  const start = Date.now();
  const db = await resolveEntry("tv", tmdbId, season, episode);
  if (db.ok) {
    const streams2 = db.streams.map(fromDbStream);
    return {
      ok: true,
      source: "vortex",
      kind: "tv",
      params: { id: tmdbId, season, episode },
      primary: streams2[0],
      streams: streams2,
      ms: Date.now() - start
    };
  }
  let streams = await timed(
    firstNonEmptyStream([
      () => resolveVidlink("tv", tmdbId, season, episode),
      () => resolveVidzee("tv", tmdbId, season, episode)
    ]),
    7e3,
    []
  );
  if (streams.length === 0)
    streams = await withVertexFallback(streams, () => resolveTv(tmdbId, season, episode));
  if (streams.length === 0) throw new Error(`Vortex could not resolve S${season}E${episode}`);
  return {
    ok: true,
    source: "vortex",
    kind: "tv",
    params: { id: tmdbId, season, episode },
    primary: streams[0],
    streams,
    ms: Date.now() - start
  };
}
async function resolveVortexAnime(idOrSlug, episode, type) {
  const start = Date.now();
  const result = await resolveAnime(idOrSlug, episode, type);
  const streams = result.streams?.length ? result.streams : [result.primary];
  if (streams.length === 0) throw new Error("Vortex could not resolve this anime episode");
  return {
    ok: true,
    source: "vortex",
    kind: "anime",
    params: { id: idOrSlug, episode, type },
    primary: streams[0],
    streams,
    ms: Date.now() - start
  };
}

// src/index.ts
var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type",
  "access-control-expose-headers": "Content-Length, Content-Range"
};
var index_default = {
  async fetch(request) {
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
          "/api/movie/{tmdbId}",
          "/api/tv/{tmdbId}/{season}/{episode}",
          "/api/stream?url={encodedUrl}"
        ]
      });
    }
    if (url.pathname.startsWith("/api/vortex/")) {
      return handleVortex(url);
    }
    if (url.pathname.startsWith("/api/movie/")) {
      return handleVortex(rewriteAlias(url, "/api/movie/", "/api/vortex/movie/"));
    }
    if (url.pathname.startsWith("/api/tv/")) {
      return handleVortex(rewriteAlias(url, "/api/tv/", "/api/vortex/tv/"));
    }
    if (url.pathname.startsWith("/api/stream")) {
      return handleStream(request);
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
};
function rewriteAlias(url, from, to) {
  const next = new URL(url.toString());
  next.pathname = next.pathname.replace(from, to);
  return next;
}
async function handleVortex(url) {
  const segs = url.pathname.replace(/^\/api\/vortex\/?/, "").split("/").filter(Boolean);
  const ttl = Math.min(Math.max(Number(url.searchParams.get("ttl")) || 600, 30), 3600);
  try {
    const { data, cached } = await withCache(
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
      }
    );
    return json(data, 200, {
      "x-cache": cached ? "HIT" : "MISS",
      "cache-control": `private, max-age=${ttl}`
    });
  } catch (error) {
    return json({ ok: false, source: "vortex", error: String(error.message ?? error) }, 502);
  }
}
async function handleStream(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (!target) return new Response("missing url", { status: 400, headers: CORS_HEADERS });
  let upstream;
  try {
    upstream = new URL(target);
  } catch {
    return new Response("bad url", { status: 400, headers: CORS_HEADERS });
  }
  const range = request.headers.get("range");
  const ref = url.searchParams.get("ref");
  const origin = url.searchParams.get("origin");
  const headers = {
    "User-Agent": DEFAULT_UA,
    Accept: "*/*",
    Referer: ref || `${upstream.protocol}//${upstream.host}/`,
    Origin: origin || `${upstream.protocol}//${upstream.host}`
  };
  if (range) headers.Range = range;
  const response = await fetch(upstream.toString(), { method: request.method, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const isManifest = /mpegurl|m3u8/i.test(contentType) || /\.m3u8(\?|$)/i.test(upstream.pathname + upstream.search);
  const responseHeaders = { ...CORS_HEADERS };
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
    headers: responseHeaders
  });
}
function rewriteManifest(manifest, upstream, requestUrl) {
  const proxyBase = new URL(requestUrl);
  const ref = proxyBase.searchParams.get("ref");
  const origin = proxyBase.searchParams.get("origin");
  proxyBase.search = "";
  const wrap = (absoluteUrl) => {
    const params = new URLSearchParams({ url: absoluteUrl });
    if (ref) params.set("ref", ref);
    if (origin) params.set("origin", origin);
    return `${proxyBase.pathname}?${params.toString()}`;
  };
  return manifest.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        return `URI="${wrap(new URL(uri, upstream).toString())}"`;
      });
    }
    return wrap(new URL(trimmed, upstream).toString());
  }).join("\n");
}
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...CORS_HEADERS,
      ...extra
    }
  });
}

// src/server.ts
var port = Number(process.env.PORT || 8787);
var hostname = process.env.HOST || "0.0.0.0";
var server = createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host || `localhost:${port}`;
    const url = `http://${host}${incoming.url || "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(key, item);
      } else if (value != null) {
        headers.set(key, value);
      }
    }
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    const request = new Request(url, {
      method: incoming.method,
      headers,
      body: hasBody ? Readable.toWeb(incoming) : void 0,
      duplex: hasBody ? "half" : void 0
    });
    const response = await index_default.fetch(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (!response.body) {
      outgoing.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(outgoing);
  } catch (error) {
    console.error(error);
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ ok: false, error: "Internal server error" }));
  }
});
server.listen(port, hostname, () => {
  console.log(`Vortex API listening on http://${hostname}:${port}`);
});
