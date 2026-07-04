import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, subscribeEvents } from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the parsed JSON body", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({ foo: 1 })));
    await expect(
      apiFetch<{ foo: number }>("/api/status", { fetchFn }),
    ).resolves.toEqual({ foo: 1 });
  });

  it("throws ApiError kind http on a non-2xx response", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse({}, 503)));
    const err = await apiFetch("/api/status", { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("http");
    expect((err as ApiError).status).toBe(503);
  });

  it("throws ApiError kind timeout when the fetch never settles", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const pending = apiFetch("/api/status", { fetchFn, timeoutMs: 1000 }).catch(
      (e) => e,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("timeout");
  });

  it("throws ApiError kind network on a fetch rejection", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const err = await apiFetch("/api/status", { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
  });

  it("propagates an external signal's abort into the combined signal", async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const fetchFn: typeof fetch = vi.fn((_input, opts) => {
      capturedSignal = opts?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const pending = apiFetch("/api/status", {
      fetchFn,
      signal: controller.signal,
    }).catch((e) => e);
    controller.abort();
    expect(capturedSignal?.aborted).toBe(true);
    const err = await pending;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("network");
  });

  it("defaults to GET with no body or content-type header", async () => {
    const fetchFn = vi.fn((_input: unknown, opts?: RequestInit) => {
      expect(opts?.method).toBe("GET");
      expect(opts?.body).toBeUndefined();
      expect(
        opts?.headers &&
          (opts.headers as Record<string, string>)["content-type"],
      ).toBeUndefined();
      return Promise.resolve(jsonResponse({ foo: 1 }));
    });
    await apiFetch("/api/status", {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("sends method, JSON content-type header, and serialized body on POST", async () => {
    const fetchFn = vi.fn((_input: unknown, opts?: RequestInit) => {
      expect(opts?.method).toBe("POST");
      expect((opts?.headers as Record<string, string>)["content-type"]).toBe(
        "application/json",
      );
      expect(opts?.body).toBe(JSON.stringify({ a: 1 }));
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    await apiFetch("/api/guestbook", {
      method: "POST",
      body: { a: 1 },
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("parses ApiError.code from a JSON {error} body on non-2xx", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "rate_limited" }, 429)),
    );
    const err = await apiFetch("/api/guestbook", {
      method: "POST",
      body: {},
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("rate_limited");
  });

  it("parses ApiError.field from a JSON {error,field} body on non-2xx", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        jsonResponse({ error: "invalid", field: "message" }, 400),
      ),
    );
    const err = await apiFetch("/api/guestbook", {
      method: "POST",
      body: {},
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("invalid");
    expect((err as ApiError).field).toBe("message");
  });

  it("leaves ApiError.code undefined on a non-JSON error body", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new SyntaxError("not json")),
      } as unknown as Response),
    );
    const err = await apiFetch("/api/status", { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBeUndefined();
  });
});

class FakeEventSource extends EventTarget {
  closed = false;
  readyState = 0; // CONNECTING; tests set 2 (CLOSED) to model a dead source
  close(): void {
    this.closed = true;
  }
}

function emit(source: FakeEventSource, type: string, data?: unknown): void {
  source.dispatchEvent(
    data === undefined
      ? new Event(type)
      : new MessageEvent(type, { data: JSON.stringify(data) }),
  );
}

describe("subscribeEvents", () => {
  it("dispatches metrics, presence, and deploy payloads", () => {
    const source = new FakeEventSource();
    const onMetrics = vi.fn();
    const onPresence = vi.fn();
    const onDeploy = vi.fn();
    subscribeEvents(
      { onMetrics, onPresence, onDeploy },
      () => source as unknown as EventSource,
    );

    emit(source, "metrics", { ts: 1, probe_ms: null });
    emit(source, "presence", { count: 2 });
    emit(source, "deploy", { sha: "abc" });

    expect(onMetrics).toHaveBeenCalledWith({ ts: 1, probe_ms: null });
    expect(onPresence).toHaveBeenCalledWith({ count: 2 });
    expect(onDeploy).toHaveBeenCalledWith({ sha: "abc" });
  });

  it("calls onDown after 3 straight errors", () => {
    const source = new FakeEventSource();
    const onDown = vi.fn();
    subscribeEvents({ onDown }, () => source as unknown as EventSource);

    emit(source, "error");
    emit(source, "error");
    expect(onDown).not.toHaveBeenCalled();
    emit(source, "error");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("calls onDown at once when the source closes without reconnecting", () => {
    const source = new FakeEventSource();
    const onDown = vi.fn();
    subscribeEvents({ onDown }, () => source as unknown as EventSource);

    source.readyState = 2; // CLOSED — e.g. a 503 that won't reconnect
    emit(source, "error");
    expect(onDown).toHaveBeenCalledTimes(1);
  });

  it("resets the error streak on a successful event", () => {
    const source = new FakeEventSource();
    const onDown = vi.fn();
    subscribeEvents({ onDown }, () => source as unknown as EventSource);

    emit(source, "error");
    emit(source, "error");
    emit(source, "presence", { count: 1 });
    emit(source, "error");
    emit(source, "error");
    expect(onDown).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe function that closes the source", () => {
    const source = new FakeEventSource();
    const unsubscribe = subscribeEvents(
      {},
      () => source as unknown as EventSource,
    );
    expect(source.closed).toBe(false);
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});
