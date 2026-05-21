const base = (process.env.STREAM_PROXY_BASE || "https://vortex-vx.irlodem27.workers.dev").replace(/\/+$/, "");

const cases = [
  {
    label: "Vortex movie: The Dark Knight",
    apiPath: "/api/vortex/movie/155",
  },
  {
    label: "Vortex show: Stranger Things S1E1",
    apiPath: "/api/vortex/tv/66732/1/1",
  },
];

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got ${response.status}: ${text.slice(0, 160)}`);
  }
}

function getStreams(data) {
  const streams = data.streams?.length ? data.streams : data.primary ? [data.primary] : [];
  return streams.filter((stream) => stream.playlist);
}

async function assertCase(testCase) {
  const apiResponse = await fetch(`${base}${testCase.apiPath}`);
  const data = await readJson(apiResponse);
  if (!apiResponse.ok || !data.ok) {
    throw new Error(`${testCase.label} API failed: ${apiResponse.status} ${data.error ?? ""}`);
  }

  const streams = getStreams(data);
  if (streams.length === 0) throw new Error(`${testCase.label} returned no HLS stream`);

  const failures = [];
  for (const [streamIndex, stream] of streams.entries()) {
    const selectedHost = new URL(stream.playlist).hostname;
    const proxyUrl = new URL(`${base}/api/stream`);
    proxyUrl.searchParams.set("url", stream.playlist);
    if (stream.headers && Object.keys(stream.headers).length > 0) {
      proxyUrl.searchParams.set("headers", JSON.stringify(stream.headers));
    }

    const proxyResponse = await fetch(proxyUrl);
    const body = await proxyResponse.text();
    const contentType = proxyResponse.headers.get("content-type") ?? "";
    const upstreamStatus = proxyResponse.headers.get("x-vortex-upstream-status");
    const rewrittenUrls = Number(proxyResponse.headers.get("x-vortex-rewritten-urls") ?? "0");

    if (proxyResponse.ok && body.startsWith("#EXTM3U") && /mpegurl/i.test(contentType) && rewrittenUrls > 0) {
      console.log(
        `[vortex-regression] ${testCase.label} ok: streamIndex=${streamIndex} host=${selectedHost} api=${apiResponse.status} proxy=${proxyResponse.status} upstream=${upstreamStatus} rewritten=${rewrittenUrls}`,
      );
      return;
    }

    failures.push(
      `streamIndex=${streamIndex} host=${selectedHost} status=${proxyResponse.status} upstream=${upstreamStatus} body=${body.slice(0, 80)}`,
    );
  }

  throw new Error(`${testCase.label} all streams failed: ${failures.join(" | ")}`);
}

for (const testCase of cases) {
  await assertCase(testCase);
}
