import {
  resolveAnime as resolveVertexAnime,
  resolveMovie as resolveVertexMovie,
  resolveTv as resolveVertexTv,
  type VertexCaption,
  type VertexStream,
} from "./vertex";
import { resolveEntry as resolveVortexDbEntry, type VortexDbStream } from "../vortex-db";

export type VortexCaption = VertexCaption;
export type VortexStream = VertexStream;

export type VortexResult = {
  ok: true;
  source: string;
  kind: "movie" | "tv" | "anime";
  params: Record<string, string | undefined>;
  primary: VortexStream;
  streams: VortexStream[];
  ms: number;
};

const VIDZEE_BASE = "https://player.vidzee.wtf";
const VIDZEE_KEY_URL = "https://core.vidzee.wtf/api-key";
const VIDZEE_KEY_SECRET = "4f2a9c7d1e8b3a6f0d5c2e9a7b1f4d8c";
const ENCRYPT_API_BASE = "https://enc-dec.app/api";
const VIDLINK_API_BASE = "https://vidlink.pro/api/b";
const VIDLINK_HEADERS = {
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro",
};
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const VORTEX_SERVERS = [
  { id: "vortex-togi", label: "Vortex Togi", sr: "0" },
  { id: "vortex-achilles", label: "Vortex Achilles", sr: "3" },
  { id: "vortex-nflix", label: "Vortex Nflix", sr: "4" },
  { id: "vortex-drag", label: "Vortex Drag", sr: "5" },
] as const;

type VidzeeTrack = { lang?: string; url?: string };
type VidzeeSource = { link?: string };
type VidzeeResponse = {
  error?: string;
  headers?: Record<string, string>;
  provider?: string;
  url?: VidzeeSource[];
  tracks?: VidzeeTrack[];
};

type VidlinkCaption = {
  id?: string;
  url?: string;
  language?: string;
  type?: string;
  hasCorsRestrictions?: boolean;
};

type VidlinkResponse = {
  stream?: {
    id?: string;
    type?: "hls" | "file";
    playlist?: string;
    qualities?: Record<string, { type: string; url: string }>;
    captions?: VidlinkCaption[];
    headers?: Record<string, string>;
  };
};

const BRIDGE_SOURCE_LABELS: Record<string, string> = {
  vidfast: "Mars API",
  vidapi: "Vid API",
  vidking: "Vidking",
  "vidsrc-cc": "VidSrc",
  "2embed": "Embed",
  prime: "Prime",
};

async function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}) {
  const { timeout = 8000, ...rest } = init;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, {
      ...rest,
      signal: ctl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/plain,*/*",
        ...(rest.headers || {}),
      },
    });
  } finally {
    clearTimeout(t);
  }
}

function b64ToBytes(input: string): Uint8Array {
  const raw = atob(input.replace(/\s+/g, ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function decryptApiKey(input: string): Promise<string> {
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
      new TextEncoder().encode(VIDZEE_KEY_SECRET),
    );
    const key = await crypto.subtle.importKey("raw", keyHash, { name: "AES-GCM" }, false, [
      "decrypt",
    ]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      payload,
    );

    return new TextDecoder().decode(decrypted);
  } catch {
    return "";
  }
}

async function decryptStreamUrl(input: string | undefined, apiKey: string): Promise<string> {
  if (!input || !apiKey) return "";

  try {
    const decoded = atob(input);
    const [ivInput, encryptedInput] = decoded.split(":");
    if (!ivInput || !encryptedInput) return "";

    const keyBytes = new TextEncoder().encode(apiKey.padEnd(32, "\0").slice(0, 32));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, [
      "decrypt",
    ]);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: toArrayBuffer(b64ToBytes(ivInput)) },
      key,
      toArrayBuffer(b64ToBytes(encryptedInput)),
    );

    let bytes = new Uint8Array(decrypted);
    const padding = bytes[bytes.length - 1];
    if (padding > 0 && padding <= 16) bytes = bytes.slice(0, -padding);

    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function normalizeCaptions(tracks?: VidzeeTrack[]): VortexCaption[] {
  return (tracks ?? []).reduce<VortexCaption[]>((captions, track, index) => {
    if (!track.url) return captions;

    captions.push({
      id: `${track.lang ?? "caption"}-${index}`,
      url: track.url,
      language: track.lang ?? "unknown",
      type: track.url.endsWith(".srt") ? "srt" : "vtt",
    });

    return captions;
  }, []);
}

function normalizeVidlinkCaptions(captions?: VidlinkCaption[]): VortexCaption[] {
  return (captions ?? []).reduce<VortexCaption[]>((acc, caption, index) => {
    if (!caption.url) return acc;

    acc.push({
      id: caption.id ?? `caption-${index}`,
      url: caption.url,
      language: caption.language ?? "unknown",
      type: caption.type === "srt" ? "srt" : "vtt",
    });

    return acc;
  }, []);
}

async function getVidzeeKey(): Promise<string> {
  const res = await fetchWithTimeout(VIDZEE_KEY_URL, {
    timeout: 5000,
    headers: {
      Referer: `${VIDZEE_BASE}/`,
      Origin: VIDZEE_BASE,
    },
  });
  if (!res.ok) return "";
  return decryptApiKey(await res.text());
}

function serverUrl(
  kind: "movie" | "tv",
  id: string,
  sr: string,
  season?: string,
  episode?: string,
): string {
  const url = new URL("/api/server", VIDZEE_BASE);
  url.searchParams.set("id", id);
  url.searchParams.set("sr", sr);
  if (kind === "tv") {
    url.searchParams.set("ss", season ?? "1");
    url.searchParams.set("ep", episode ?? "1");
  }
  return url.toString();
}

async function resolveVidzeeServer(
  kind: "movie" | "tv",
  id: string,
  apiKey: string,
  server: (typeof VORTEX_SERVERS)[number],
  season?: string,
  episode?: string,
): Promise<VortexStream | null> {
  try {
    const res = await fetchWithTimeout(serverUrl(kind, id, server.sr, season, episode), {
      timeout: 6500,
      headers: {
        Referer: `${VIDZEE_BASE}/embed/${kind}/${id}`,
        Origin: VIDZEE_BASE,
      },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as VidzeeResponse;
    if (data.error || !data.url?.length) return null;

    const urls = await Promise.all(data.url.map((source) => decryptStreamUrl(source.link, apiKey)));
    const playlist = urls.find(Boolean);
    if (!playlist) return null;

    return {
      id: server.id,
      label: server.label,
      type: "hls",
      playlist,
      captions: normalizeCaptions(data.tracks),
      headers: {
        ...(data.headers ?? {}),
        Referer: `${VIDZEE_BASE}/embed/${kind}/${id}`,
        Origin: VIDZEE_BASE,
      },
      upstream: `vortex/vidzee/${server.sr}`,
    };
  } catch {
    return null;
  }
}

async function resolveVidzee(
  kind: "movie" | "tv",
  id: string,
  season?: string,
  episode?: string,
): Promise<VortexStream[]> {
  const apiKey = await getVidzeeKey();
  if (!apiKey) return [];

  const settled = await Promise.all(
    VORTEX_SERVERS.map((server) => resolveVidzeeServer(kind, id, apiKey, server, season, episode)),
  );

  return settled.filter((stream): stream is VortexStream => !!stream);
}

async function resolveVidzeeSelected(
  sourceId: string,
  servers: Array<(typeof VORTEX_SERVERS)[number]["id"]>,
  kind: "movie" | "tv",
  id: string,
  season?: string,
  episode?: string,
): Promise<VortexStream[]> {
  const apiKey = await getVidzeeKey();
  if (!apiKey) return [];

  const selected = VORTEX_SERVERS.filter((server) => servers.includes(server.id));
  const settled = await Promise.all(
    selected.map((server) => resolveVidzeeServer(kind, id, apiKey, server, season, episode)),
  );

  return asBridgeStreams(sourceId, settled.filter((stream): stream is VortexStream => !!stream), "vidzee");
}

async function encryptVidlinkId(id: string): Promise<string> {
  const url = new URL(`${ENCRYPT_API_BASE}/enc-vidlink`);
  url.searchParams.set("text", id);
  const res = await fetchWithTimeout(url.toString(), { timeout: 5000 });
  if (!res.ok) return "";

  const data = (await res.json()) as { result?: string };
  return data.result ?? "";
}

async function resolveVidlink(
  kind: "movie" | "tv",
  id: string,
  season?: string,
  episode?: string,
): Promise<VortexStream[]> {
  try {
    const encryptedId = await encryptVidlinkId(id);
    if (!encryptedId) return [];

    const url =
      kind === "movie"
        ? `${VIDLINK_API_BASE}/movie/${encryptedId}?multiLang=0`
        : `${VIDLINK_API_BASE}/tv/${encryptedId}/${season}/${episode}?multiLang=0`;

    const res = await fetchWithTimeout(url, {
      timeout: 6500,
      headers: {
        Referer: "https://vidlink.pro/",
        Origin: "https://vidlink.pro",
      },
    });
    if (!res.ok) return [];

    const data = (await res.json()) as VidlinkResponse;
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
          headers: { ...VIDLINK_HEADERS, ...(stream.headers ?? {}) },
          upstream: "vortex/link",
        },
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
          headers: { ...VIDLINK_HEADERS, ...(stream.headers ?? {}) },
          upstream: "vortex/link",
        },
      ];
    }

    return [];
  } catch {
    return [];
  }
}

async function timed<T>(promise: Promise<T>, timeout: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function firstNonEmptyStream(
  resolvers: Array<() => Promise<VortexStream[]>>,
): Promise<VortexStream[]> {
  const pending = resolvers.map((resolver) =>
    resolver()
      .then((streams) => uniqueStreams(streams))
      .catch(() => []),
  );
  const settled: VortexStream[][] = [];

  while (pending.length > 0) {
    const indexed = pending.map((promise, index) =>
      promise.then((streams) => ({ index, streams })),
    );
    const { index, streams } = await Promise.race(indexed);
    pending.splice(index, 1);
    settled.push(streams);

    if (streams.length > 0) return streams;
  }

  return uniqueStreams(settled.flat());
}

function uniqueStreams(streams: VortexStream[]): VortexStream[] {
  const seen = new Set<string>();
  return streams.filter((stream) => {
    const key = stream.playlist ?? JSON.stringify(stream.qualities ?? {});
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fromDbStream(stream: VortexDbStream): VortexStream {
  return {
    ...stream,
    captions: stream.captions ?? [],
    upstream: "vortex/db",
  };
}

async function withVertexFallback(
  streams: VortexStream[],
  fallback: () => Promise<{ streams?: VortexStream[]; primary?: VortexStream }>,
): Promise<VortexStream[]> {
  if (streams.length >= 2) return streams;

  try {
    const result = await fallback();
    return uniqueStreams([
      ...streams,
      ...(result.streams?.length ? result.streams : result.primary ? [result.primary] : []),
    ]);
  } catch {
    return streams;
  }
}

export async function resolveVortexMovie(tmdbId: string): Promise<VortexResult> {
  const start = Date.now();
  const db = await resolveVortexDbEntry("movie", tmdbId);
  if (db.ok) {
    const streams = db.streams.map(fromDbStream);
    return {
      ok: true,
      source: "vortex",
      kind: "movie",
      params: { id: tmdbId },
      primary: streams[0],
      streams,
      ms: Date.now() - start,
    };
  }

  const [vidzeeStreams, linkStreams] = await Promise.all([
    timed(resolveVidzee("movie", tmdbId), 7000, []),
    timed(resolveVidlink("movie", tmdbId), 7000, []),
  ]);
  let streams = uniqueStreams([...vidzeeStreams, ...linkStreams]);
  streams = await withVertexFallback(streams, () => resolveVertexMovie(tmdbId));
  if (streams.length === 0) throw new Error("Vortex could not resolve a stream for this movie");

  return {
    ok: true,
    source: "vortex",
    kind: "movie",
    params: { id: tmdbId },
    primary: streams[0],
    streams,
    ms: Date.now() - start,
  };
}

function asBridgeStreams(sourceId: string, streams: VortexStream[], upstream: string): VortexStream[] {
  const labelBase = BRIDGE_SOURCE_LABELS[sourceId] ?? sourceId;
  return uniqueStreams(streams).map((stream, index) => ({
    ...stream,
    id: `${sourceId}-${stream.id ?? index}`,
    label: `${labelBase}${stream.label ? ` - ${stream.label.replace(/^Vortex\s*/i, "")}` : ""}`,
    upstream: `${sourceId}/${upstream}`,
  }));
}

export async function resolveVortexMovieBySource(tmdbId: string, sourceId: string): Promise<VortexResult> {
  const start = Date.now();
  const streams = await resolveBridgeMovie(sourceId, tmdbId);
  if (streams.length === 0) throw new Error(`${BRIDGE_SOURCE_LABELS[sourceId] ?? sourceId} returned no stream`);

  return {
    ok: true,
    source: sourceId,
    kind: "movie",
    params: { id: tmdbId, source: sourceId },
    primary: streams[0],
    streams,
    ms: Date.now() - start,
  };
}

export async function resolveVortexTv(
  tmdbId: string,
  season: string,
  episode: string,
): Promise<VortexResult> {
  const start = Date.now();
  const db = await resolveVortexDbEntry("tv", tmdbId, season, episode);
  if (db.ok) {
    const streams = db.streams.map(fromDbStream);
    return {
      ok: true,
      source: "vortex",
      kind: "tv",
      params: { id: tmdbId, season, episode },
      primary: streams[0],
      streams,
      ms: Date.now() - start,
    };
  }

  let streams = await timed(
    firstNonEmptyStream([
      () => resolveVidlink("tv", tmdbId, season, episode),
      () => resolveVidzee("tv", tmdbId, season, episode),
    ]),
    7000,
    [],
  );
  if (streams.length === 0)
    streams = await withVertexFallback(streams, () => resolveVertexTv(tmdbId, season, episode));
  if (streams.length === 0) throw new Error(`Vortex could not resolve S${season}E${episode}`);

  return {
    ok: true,
    source: "vortex",
    kind: "tv",
    params: { id: tmdbId, season, episode },
    primary: streams[0],
    streams,
    ms: Date.now() - start,
  };
}

export async function resolveVortexTvBySource(
  tmdbId: string,
  season: string,
  episode: string,
  sourceId: string,
): Promise<VortexResult> {
  const start = Date.now();
  const streams = await resolveBridgeTv(sourceId, tmdbId, season, episode);
  if (streams.length === 0)
    throw new Error(`${BRIDGE_SOURCE_LABELS[sourceId] ?? sourceId} returned no stream for S${season}E${episode}`);

  return {
    ok: true,
    source: sourceId,
    kind: "tv",
    params: { id: tmdbId, season, episode, source: sourceId },
    primary: streams[0],
    streams,
    ms: Date.now() - start,
  };
}

async function resolveBridgeMovie(sourceId: string, tmdbId: string): Promise<VortexStream[]> {
  // These labels must not silently route to GoatAPI/Lightning or Vortex. Each source
  // needs a real extractor for its own public player/API before it can be enabled here.
  void sourceId;
  void tmdbId;
  return [];
}

async function resolveBridgeTv(
  sourceId: string,
  tmdbId: string,
  season: string,
  episode: string,
): Promise<VortexStream[]> {
  // These labels must not silently route to GoatAPI/Lightning or Vortex. Each source
  // needs a real extractor for its own public player/API before it can be enabled here.
  void sourceId;
  void tmdbId;
  void season;
  void episode;
  return [];
}

export async function resolveVortexAnime(
  idOrSlug: string,
  episode: string,
  type: "sub" | "dub",
): Promise<VortexResult> {
  const start = Date.now();
  const result = await resolveVertexAnime(idOrSlug, episode, type);
  const streams = result.streams?.length ? result.streams : [result.primary];
  if (streams.length === 0) throw new Error("Vortex could not resolve this anime episode");

  return {
    ok: true,
    source: "vortex",
    kind: "anime",
    params: { id: idOrSlug, episode, type },
    primary: streams[0],
    streams,
    ms: Date.now() - start,
  };
}
