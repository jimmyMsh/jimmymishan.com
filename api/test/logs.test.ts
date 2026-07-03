import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type LogEventData,
  type LogLine,
  LogTail,
  type LogTailDeps,
} from "../src/logs/listener.js";
import { logsRoutes } from "../src/routes/logs.js";
import type { SseHub } from "../src/sse.js";

const PUBLIC_IP = "203.0.113.7";

type BroadcastMock = Mock<(event: string, data: unknown) => void>;
type GeoMock = { country: Mock<(ip: string) => string> };

function makeHub(): { hub: SseHub; broadcast: BroadcastMock } {
  const broadcast: BroadcastMock = vi.fn();
  return { hub: { broadcast } as unknown as SseHub, broadcast };
}

function makeGeo(country = "US"): GeoMock {
  return { country: vi.fn<(ip: string) => string>(() => country) };
}

function makeTail(overrides: Partial<LogTailDeps> = {}): {
  tail: LogTail;
  broadcast: BroadcastMock;
  geo: GeoMock;
} {
  const { hub, broadcast } = makeHub();
  const geo = makeGeo();
  const tail = new LogTail({
    hub,
    geo,
    allowPrivate: false,
    ...overrides,
  });
  return { tail, broadcast, geo };
}

function tailfmt(o: {
  iso?: string;
  method?: string;
  uri: string;
  status?: number;
  ip: string;
}): string {
  const iso = o.iso ?? "2026-07-03T15:04:05+00:00";
  const method = o.method ?? "GET";
  const status = o.status ?? 200;
  return `${iso} ${method} "${o.uri}" ${status} ${o.ip}`;
}

function syslog(line: string): string {
  return `<190>Jul  3 15:04:05 web ngx: ${line}`;
}

function ingestPublic(tail: LogTail, uri: string, ip = PUBLIC_IP): void {
  tail.ingest(syslog(tailfmt({ uri, ip })));
}

describe("LogTail.ingest — parsing", () => {
  it("parses a full syslog line into the exact LogLine and never keeps the IP", () => {
    const { tail } = makeTail();
    tail.ingest(
      syslog(`2026-07-03T15:04:05+00:00 GET "/projects" 200 ${PUBLIC_IP}`),
    );

    const lines = tail.recent();
    expect(lines).toEqual([
      {
        ts: 1783091045,
        method: "GET",
        path: "/projects",
        status: 200,
        country: "US",
      } satisfies LogLine,
    ]);
    expect(JSON.stringify(lines)).not.toContain(PUBLIC_IP);
  });

  it("looks the source IP up for geo but discards it from the LogLine", () => {
    const { tail, geo } = makeTail();
    ingestPublic(tail, "/about");

    expect(geo.country).toHaveBeenCalledWith(PUBLIC_IP);
    const [entry] = tail.recent();
    expect(Object.values(entry)).not.toContain(PUBLIC_IP);
    expect(entry.country).toBe("US");
  });

  it("keeps an escaped-quote path (\\x22) whole", () => {
    const { tail } = makeTail();
    ingestPublic(tail, "/search\\x22drop");

    expect(tail.recent()[0].path).toBe("/search\\x22drop");
  });

  it("does not re-strip a query string present inside the quoted field", () => {
    const { tail } = makeTail();
    ingestPublic(tail, "/search?q=cats&x=1");

    expect(tail.recent()[0].path).toBe("/search?q=cats&x=1");
  });

  it("truncates a path longer than 80 characters to 80", () => {
    const { tail } = makeTail();
    const longPath = `/${"a".repeat(120)}`;
    ingestPublic(tail, longPath);

    const { path } = tail.recent()[0];
    expect(path.length).toBe(80);
    expect(path).toBe(longPath.slice(0, 80));
  });

  it.each([
    ["empty string", ""],
    ["no syslog structure", "just some random text"],
    [
      "missing quoted uri",
      syslog(`2026-07-03T15:04:05+00:00 GET /nope 200 ${PUBLIC_IP}`),
    ],
    ["missing trailing fields", syslog(`2026-07-03T15:04:05+00:00 GET "/x"`)],
    [
      "non-numeric status",
      syslog(`2026-07-03T15:04:05+00:00 GET "/x" NaN ${PUBLIC_IP}`),
    ],
    ["unparseable timestamp", syslog(`not-a-date GET "/x" 200 ${PUBLIC_IP}`)],
    ["truncated mid-line", syslog(`2026-07-03T15:04:05+00:00 GET "/proj`)],
  ])("drops a malformed line silently (%s)", (_label, raw) => {
    const { tail, broadcast } = makeTail();
    expect(() => tail.ingest(raw)).not.toThrow();
    expect(tail.recent()).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("LogTail.ingest — filters", () => {
  it.each([
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.1",
    "127.0.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
  ])("skips private/loopback source %s when allowPrivate is false", (ip) => {
    const { tail, geo } = makeTail();
    tail.ingest(syslog(tailfmt({ uri: "/x", ip })));

    expect(tail.recent()).toEqual([]);
    expect(geo.country).not.toHaveBeenCalled();
  });

  it("keeps public sources on the edge of the private ranges", () => {
    const { tail } = makeTail();
    tail.ingest(syslog(tailfmt({ uri: "/a", ip: "172.15.0.1" })));
    tail.ingest(syslog(tailfmt({ uri: "/b", ip: "172.32.0.1" })));

    expect(tail.recent().map((l) => l.path)).toEqual(["/a", "/b"]);
  });

  it("keeps private sources with country '--' when allowPrivate is true", () => {
    const { tail, geo } = makeTail({ allowPrivate: true });
    tail.ingest(syslog(tailfmt({ uri: "/dev", ip: "10.1.2.3" })));

    const [entry] = tail.recent();
    expect(entry.country).toBe("--");
    expect(entry.path).toBe("/dev");
    expect(geo.country).not.toHaveBeenCalled();
    expect(JSON.stringify(tail.recent())).not.toContain("10.1.2.3");
  });

  it("skips the deploy webhook path", () => {
    const { tail } = makeTail();
    ingestPublic(tail, "/api/deploys/webhook");

    expect(tail.recent()).toEqual([]);
  });
});

describe("LogTail.recent — ring buffer", () => {
  it("keeps only the last 100 lines oldest→newest", () => {
    const { tail } = makeTail();
    for (let i = 0; i < 105; i++) {
      ingestPublic(tail, `/p${i}`);
    }

    const lines = tail.recent();
    expect(lines).toHaveLength(100);
    expect(lines[0].path).toBe("/p5");
    expect(lines[99].path).toBe("/p104");
  });

  it("returns a copy that cannot mutate the ring", () => {
    const { tail } = makeTail();
    ingestPublic(tail, "/one");

    tail.recent().push({
      ts: 0,
      method: "GET",
      path: "/injected",
      status: 200,
      country: "US",
    });

    expect(tail.recent()).toHaveLength(1);
  });
});

describe("LogTail — coalescing broadcast (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits one 'log' broadcast 250ms after the first pending line", () => {
    vi.useFakeTimers();
    const { tail, broadcast } = makeTail();

    ingestPublic(tail, "/a");
    ingestPublic(tail, "/b");
    ingestPublic(tail, "/c");
    expect(broadcast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(broadcast).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [event, data] = broadcast.mock.calls[0] as [string, LogEventData];
    expect(event).toBe("log");
    expect(data.lines).toHaveLength(3);
    expect(data.dropped).toBe(0);
    expect(JSON.stringify(data)).not.toContain(PUBLIC_IP);
  });

  it("caps a burst at 10 lines and reports the remainder as dropped", () => {
    vi.useFakeTimers();
    const { tail, broadcast } = makeTail();

    for (let i = 0; i < 25; i++) {
      ingestPublic(tail, `/burst${i}`);
    }

    vi.advanceTimersByTime(250);

    expect(broadcast).toHaveBeenCalledTimes(1);
    const data = broadcast.mock.calls[0][1] as LogEventData;
    expect(data.lines).toHaveLength(10);
    expect(data.dropped).toBe(15);
  });

  it("does not broadcast again while idle after a flush", () => {
    vi.useFakeTimers();
    const { tail, broadcast } = makeTail();

    ingestPublic(tail, "/a");
    vi.advanceTimersByTime(250);
    expect(broadcast).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh window for lines that arrive after a flush", () => {
    vi.useFakeTimers();
    const { tail, broadcast } = makeTail();

    ingestPublic(tail, "/a");
    vi.advanceTimersByTime(250);

    ingestPublic(tail, "/b");
    vi.advanceTimersByTime(250);

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect((broadcast.mock.calls[1][1] as LogEventData).lines[0].path).toBe(
      "/b",
    );
  });

  it("stop() clears the pending flush timer so nothing is broadcast", () => {
    vi.useFakeTimers();
    const { tail, broadcast } = makeTail();

    ingestPublic(tail, "/a");
    tail.stop();

    vi.advanceTimersByTime(1000);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe("LogTail.start — socket errors", () => {
  it("surfaces a bind failure via console.warn instead of crashing", async () => {
    // Occupy a real UDP port so tail.start()'s own bind() fails with
    // EADDRINUSE, exercising the socket's actual 'error' event rather than a
    // synthetic one.
    const blocker = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      blocker.once("listening", resolve);
      blocker.once("error", reject);
      blocker.bind(0);
    });
    const port = (blocker.address() as { port: number }).port;

    let resolveErrored = () => {};
    const errored = new Promise<void>((resolve) => {
      resolveErrored = resolve;
    });
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => resolveErrored());

    const { tail } = makeTail();
    try {
      expect(() => tail.start(port)).not.toThrow();
      await errored;

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("log listener socket error");
    } finally {
      tail.stop();
      blocker.close();
      warn.mockRestore();
    }
  });
});

describe("logsRoutes", () => {
  it("returns 503 disabled when the tail is null", async () => {
    const app = logsRoutes({ tail: null });

    const res = await app.request("/api/logs");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "disabled" });
  });

  it("returns the current ring contents when a tail is present", async () => {
    const { tail } = makeTail();
    ingestPublic(tail, "/live");
    const app = logsRoutes({ tail });

    const res = await app.request("/api/logs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: LogLine[] };
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].path).toBe("/live");
    expect(JSON.stringify(body)).not.toContain(PUBLIC_IP);
  });
});
