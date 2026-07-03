import { describe, expect, it, vi } from "vitest";
import { SseHub } from "../src/sse.js";

function mkClient() {
  return { send: vi.fn(), close: vi.fn() };
}

describe("SseHub", () => {
  it("tracks count through add and remove", () => {
    const hub = new SseHub({ maxConnections: 10 });
    expect(hub.count).toBe(0);

    const removeA = hub.add(mkClient());
    expect(hub.count).toBe(1);

    const removeB = hub.add(mkClient());
    expect(hub.count).toBe(2);

    removeA();
    expect(hub.count).toBe(1);

    removeB();
    expect(hub.count).toBe(0);
  });

  it("broadcasts to every client with the event name and json payload", () => {
    const hub = new SseHub({ maxConnections: 10 });
    const a = mkClient();
    const b = mkClient();
    hub.add(a);
    hub.add(b);

    hub.broadcast("metrics", { cpu_pct: 12 });

    expect(a.send).toHaveBeenCalledWith(
      "metrics",
      JSON.stringify({ cpu_pct: 12 }),
    );
    expect(b.send).toHaveBeenCalledWith(
      "metrics",
      JSON.stringify({ cpu_pct: 12 }),
    );
  });

  it("drops a client whose send throws", () => {
    const hub = new SseHub({ maxConnections: 10 });
    const bad = {
      send: vi.fn(() => {
        throw new Error("broken pipe");
      }),
      close: vi.fn(),
    };
    hub.add(bad);
    expect(hub.count).toBe(1);

    hub.broadcast("deploy", { sha: "abc" });

    expect(hub.count).toBe(0);
  });

  it("reports capacity at the configured maximum", () => {
    const hub = new SseHub({ maxConnections: 2 });
    expect(hub.atCapacity()).toBe(false);

    hub.add(mkClient());
    expect(hub.atCapacity()).toBe(false);

    hub.add(mkClient());
    expect(hub.atCapacity()).toBe(true);
  });

  it("debounces rapid join/leave into one presence broadcast", () => {
    vi.useFakeTimers();
    try {
      const hub = new SseHub({ maxConnections: 10, presenceDebounceMs: 1000 });
      const listener = mkClient();
      hub.add(listener);

      const removeSecond = hub.add(mkClient());
      removeSecond();

      expect(listener.send).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);

      expect(listener.send).toHaveBeenCalledTimes(1);
      expect(listener.send).toHaveBeenCalledWith(
        "presence",
        JSON.stringify({ count: 1 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
