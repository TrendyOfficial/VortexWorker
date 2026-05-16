// Vertex: our own stream resolver. Fans out to multiple upstream scraper APIs
// in parallel with timeouts, retries, and failover. Returns a normalized
// payload that our HLS player can consume directly.

export type VertexCaption = { id: string; url: string; language: string; type: "vtt" | "srt" };
export type VertexStream = {
  id: string;
  label: string;
  type: "hls" | "file";
  playlist?: string; // hls
  qualities?: Record<string, { type: string; url: string }>; // file
  captions: VertexCaption[];
  headers?: Record<string, string>;
  upstream: string; // which scraper produced it
};

export type VertexResult = {
  ok: true;
  source: "vertex";
  kind: "movie" | "tv" | "anime";
  params: Record<string, string | undefined>;
  primary: VertexStream;
  streams: VertexStream[]; // for client-side failover
  ms: number;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

async function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 8000, ...rest } = init;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { ...rest, signal: ctl.signal, headers: { "User-Agent": UA, Accept: "*/*", ...(rest.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2, baseDelay = 250): Promise<T> {
  let lastErr: unknown;
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

// ---------- Upstream A: Consumet FlixHQ (movies & tv) ----------
const CONSUMET_BASES = [
  "https://api.consumet.org",
  "https://consumet-api-puce.vercel.app",
];

async function consumetGet(path: string): Promise<unknown> {
  let lastErr: unknown;
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

type FlixSearchItem = { id: string; title: string; releaseDate?: string; type?: string };
type FlixInfo = { id: string; title: string; episodes: Array<{ id: string; number: number; season?: number; title?: string }> };
type FlixSources = { sources: Array<{ url: string; quality?: string; isM3U8?: boolean }>; subtitles?: Array<{ url: string; lang: string }>; headers?: Record<string, string> };

async function flixhqResolveByTmdb(
  kind: "movie" | "tv",
  title: string,
  year: string | undefined,
  season?: string,
  episode?: string,
): Promise<VertexStream | null> {
  const search = (await consumetGet(`/movies/flixhq/${encodeURIComponent(title)}`)) as { results?: FlixSearchItem[] };
  const wantType = kind === "movie" ? "Movie" : "TV Series";
  const candidates = (search.results || []).filter((r) => (r.type ?? "").toLowerCase().includes(kind === "movie" ? "movie" : "tv"));
  // prefer year match
  const pick =
    candidates.find((c) => year && c.releaseDate?.startsWith(year)) ||
    candidates[0];
  if (!pick) return null;

  const info = (await consumetGet(`/movies/flixhq/info?id=${encodeURIComponent(pick.id)}`)) as FlixInfo;
  const ep =
    kind === "movie"
      ? info.episodes?.[0]
      : info.episodes?.find((e) => String(e.season ?? "") === String(season) && String(e.number) === String(episode));
  if (!ep) return null;

  // Try multiple servers in order.
  const servers = ["upcloud", "vidcloud"];
  for (const server of servers) {
    try {
      const data = (await consumetGet(
        `/movies/flixhq/watch?episodeId=${encodeURIComponent(ep.id)}&mediaId=${encodeURIComponent(pick.id)}&server=${server}`,
      )) as FlixSources;
      const m3u8 = data.sources?.find((s) => s.isM3U8 || s.url?.includes(".m3u8"))?.url;
      if (!m3u8) continue;
      return {
        id: `flixhq-${server}`,
        label: `FlixHQ (${server})`,
        type: "hls",
        playlist: m3u8,
        captions: (data.subtitles || []).map((s, i) => ({
          id: `cap-${i}`,
          url: s.url,
          language: s.lang,
          type: s.url.endsWith(".srt") ? "srt" : "vtt",
        })),
        headers: data.headers,
        upstream: `consumet/flixhq/${server}`,
      };
    } catch {
      /* try next server */
    }
  }
  return null;
}

// ---------- Upstream B: Consumet Gogoanime (anime) ----------
type GogoSearchItem = { id: string; title: string };
type GogoInfo = { id: string; episodes?: Array<{ id: string; number: number }> };
type GogoSources = { sources?: Array<{ url: string; quality?: string; isM3U8?: boolean }>; headers?: Record<string, string> };

async function gogoResolve(idOrSlug: string, episode: string, type: "sub" | "dub"): Promise<VertexStream | null> {
  // If id looks numeric (MAL), search by it (gogoanime doesn't index by MAL — best effort).
  const search = (await consumetGet(`/anime/gogoanime/${encodeURIComponent(idOrSlug)}`)) as { results?: GogoSearchItem[] };
  const pick =
    (search.results || []).find((r) => (type === "dub" ? /dub/i.test(r.title) : !/dub/i.test(r.title))) ||
    (search.results || [])[0];
  if (!pick) return null;
  const info = (await consumetGet(`/anime/gogoanime/info/${encodeURIComponent(pick.id)}`)) as GogoInfo;
  const ep = info.episodes?.find((e) => String(e.number) === String(episode));
  if (!ep) return null;
  for (const server of ["gogocdn", "vidstreaming", "streamsb"]) {
    try {
      const data = (await consumetGet(`/anime/gogoanime/watch/${encodeURIComponent(ep.id)}?server=${server}`)) as GogoSources;
      const m3u8 = data.sources?.find((s) => s.isM3U8 || s.url?.includes(".m3u8"))?.url;
      if (!m3u8) continue;
      return {
        id: `gogo-${server}`,
        label: `Gogoanime (${server})`,
        type: "hls",
        playlist: m3u8,
        captions: [],
        headers: data.headers,
        upstream: `consumet/gogoanime/${server}`,
      };
    } catch {
      /* next */
    }
  }
  return null;
}

// ---------- TMDB title lookup ----------
const TMDB_KEY = "3a68cdec21c0ca11a86e96fa7ee94a4c";

async function tmdbTitle(kind: "movie" | "tv", id: string): Promise<{ title: string; year?: string }> {
  const r = await fetchWithTimeout(`https://api.themoviedb.org/3/${kind}/${id}?api_key=${TMDB_KEY}`, { timeout: 5000 });
  if (!r.ok) throw new Error(`tmdb ${r.status}`);
  const j = (await r.json()) as { title?: string; name?: string; release_date?: string; first_air_date?: string };
  const title = j.title || j.name || "";
  const date = j.release_date || j.first_air_date || "";
  return { title, year: date ? date.slice(0, 4) : undefined };
}

// ---------- Public entry points ----------
export async function resolveMovie(tmdbId: string): Promise<VertexResult> {
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
    ms: Date.now() - start,
  };
}

export async function resolveTv(tmdbId: string, season: string, episode: string): Promise<VertexResult> {
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
    ms: Date.now() - start,
  };
}

export async function resolveAnime(idOrSlug: string, episode: string, type: "sub" | "dub"): Promise<VertexResult> {
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
    ms: Date.now() - start,
  };
}