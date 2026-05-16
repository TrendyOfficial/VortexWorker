export type VortexDbKind = "movie" | "tv";

export type VortexDbEntry = {
  id: string;
  kind: VortexDbKind;
  tmdbId: string;
  title: string;
  season?: string;
  episode?: string;
  quality: string;
  url: string;
  captions?: Array<{ id: string; url: string; language: string; type: "vtt" | "srt" }>;
  createdAt: string;
};

export type VortexDbStream = {
  id: string;
  label: string;
  type: "hls" | "file";
  playlist?: string;
  qualities?: Record<string, { type: string; url: string }>;
  captions: VortexDbEntry["captions"];
};

export type VortexDbResolve =
  | {
      ok: true;
      source: "vortex-db";
      kind: VortexDbKind;
      primary: VortexDbStream;
      streams: VortexDbStream[];
    }
  | {
      ok: false;
      source: "vortex-db";
      kind: VortexDbKind;
      missing: true;
      placeholder: {
        label: string;
        pattern: "- - - ----";
      };
    };

const MEMORY_KEY = "vortex-db:entries";

function readEnv(name: string): string | undefined {
  const runtime = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name];
}

const UPSTASH_URL = readEnv("VORTEX_DB_REST_URL");
const UPSTASH_TOKEN = readEnv("VORTEX_DB_REST_TOKEN");

let memoryEntries: VortexDbEntry[] = [];

function hasUpstash() {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}

async function upstash<T>(path: string): Promise<T> {
  const response = await fetch(`${UPSTASH_URL}/${path}`, {
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
    },
  });
  if (!response.ok) throw new Error(`Vortex DB storage ${response.status}`);
  const data = (await response.json()) as { result: T };
  return data.result;
}

export function getBackendSlug() {
  return readEnv("VORTEX_DB_BACKEND_SLUG") ?? "vx9k4m2q7-private-db";
}

export function getBackendCredentials() {
  return {
    username: readEnv("VORTEX_DB_USERNAME") ?? "vortex",
    password: readEnv("VORTEX_DB_PASSWORD") ?? "change-me",
  };
}

export async function readEntries(): Promise<VortexDbEntry[]> {
  if (!hasUpstash()) return memoryEntries;

  const raw = await upstash<string | null>(`get/${MEMORY_KEY}`);
  if (!raw) return [];
  return JSON.parse(raw) as VortexDbEntry[];
}

export async function writeEntries(entries: VortexDbEntry[]) {
  if (!hasUpstash()) {
    memoryEntries = entries;
    return;
  }

  await upstash<unknown>(`set/${MEMORY_KEY}/${encodeURIComponent(JSON.stringify(entries))}`);
}

export async function addEntry(input: Omit<VortexDbEntry, "id" | "createdAt">) {
  const entries = await readEntries();
  const next: VortexDbEntry = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  entries.unshift(next);
  await writeEntries(entries);
  return next;
}

export async function resolveEntry(kind: VortexDbKind, tmdbId: string, season?: string, episode?: string): Promise<VortexDbResolve> {
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
        pattern: "- - - ----",
      },
    };
  }

  const isHls = /\.m3u8(\?|$)/i.test(match.url);
  const primary = isHls
    ? {
        id: "vortex-db",
        label: `Vortex DB ${match.quality}`,
        type: "hls" as const,
        playlist: match.url,
        captions: match.captions ?? [],
      }
    : {
        id: "vortex-db",
        label: `Vortex DB ${match.quality}`,
        type: "file" as const,
        qualities: {
          [match.quality]: { type: "mp4", url: match.url },
        },
        captions: match.captions ?? [],
      };

  return {
    ok: true,
    source: "vortex-db",
    kind,
    primary,
    streams: [primary],
  };
}
