import { createServer } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import worker from "./index";

const port = Number(process.env.PORT || 8787);
const hostname = process.env.HOST || "0.0.0.0";

const server = createServer(async (incoming, outgoing) => {
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
      body: hasBody ? (Readable.toWeb(incoming) as ReadableStream) : undefined,
      duplex: hasBody ? "half" : undefined,
    } as RequestInit & { duplex?: "half" });

    const response = await worker.fetch(request);
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));

    if (!response.body) {
      outgoing.end();
      return;
    }

    Readable.fromWeb(response.body as unknown as NodeReadableStream).pipe(outgoing);
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

