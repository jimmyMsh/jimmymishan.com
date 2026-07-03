import { describe, expect, it, vi } from "vitest";
import { eventsRoute } from "../src/routes/events.js";
import { SseHub } from "../src/sse.js";

function mkClient() {
  return { send: vi.fn(), close: vi.fn() };
}

async function readUntil(
  body: ReadableStream<Uint8Array>,
  marker: string,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(marker)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text;
}

describe("GET /api/events", () => {
  it("returns 503 with Retry-After when the hub is at capacity", async () => {
    const hub = new SseHub({ maxConnections: 1 });
    hub.add(mkClient());
    const app = eventsRoute({ hub, latestMetrics: () => null });

    const res = await app.request("/api/events");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("streams presence and metrics frames immediately on connect", async () => {
    const hub = new SseHub({ maxConnections: 10 });
    const app = eventsRoute({ hub, latestMetrics: () => ({ cpu_pct: 5 }) });

    const res = await app.request("/api/events");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await readUntil(
      res.body as ReadableStream<Uint8Array>,
      "event: metrics",
    );

    expect(text).toContain("event: presence");
    expect(text).toContain("event: metrics");
  });

  it("omits the metrics frame when there is no latest sample yet", async () => {
    const hub = new SseHub({ maxConnections: 10 });
    const app = eventsRoute({ hub, latestMetrics: () => null });

    const res = await app.request("/api/events");
    const text = await readUntil(
      res.body as ReadableStream<Uint8Array>,
      "event: presence",
    );

    expect(text).toContain("event: presence");
    expect(text).not.toContain("event: metrics");
  });
});
