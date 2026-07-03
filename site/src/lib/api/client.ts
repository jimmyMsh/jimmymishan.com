import type { DeployRecord, MetricsEventData } from "./types";

export class ApiError extends Error {
  readonly kind: "timeout" | "network" | "http";
  readonly status?: number;

  constructor(
    kind: "timeout" | "network" | "http",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

export interface ApiFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
  }
}

export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const { timeoutMs = 3000, signal: external, fetchFn = fetch } = opts;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combined = external
    ? AbortSignal.any([timeoutController.signal, external])
    : timeoutController.signal;

  // fetchFn isn't guaranteed to honor `combined` (e.g. injected test
  // doubles), so the timeout/abort is enforced independently here rather
  // than relying solely on the fetch call rejecting.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("aborted"));
    if (combined.aborted) fail();
    else combined.addEventListener("abort", fail, { once: true });
  });

  try {
    const fetchPromise = fetchFn(path, { signal: combined });
    fetchPromise.catch(() => {});
    const res = await Promise.race([fetchPromise, aborted]);
    if (!res.ok) throw new HttpStatusError(res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof HttpStatusError) {
      throw new ApiError("http", `${path}: http ${err.status}`, err.status);
    }
    if (timeoutController.signal.aborted) {
      throw new ApiError("timeout", `${path}: timed out after ${timeoutMs}ms`);
    }
    throw new ApiError("network", `${path}: network error`);
  } finally {
    clearTimeout(timer);
  }
}

export interface SubscribeHandlers {
  onMetrics?(data: MetricsEventData): void;
  onPresence?(data: { count: number }): void;
  onDeploy?(data: DeployRecord): void;
  onDown?(): void;
}

const EVENTS_PATH = "/api/events";
const DOWN_AFTER_ERRORS = 3;
const SOURCE_CLOSED = 2; // EventSource.CLOSED — the source will not reconnect

export function subscribeEvents(
  handlers: SubscribeHandlers,
  makeSource: (url: string) => EventSource = (url) => new EventSource(url),
): () => void {
  const source = makeSource(EVENTS_PATH);
  let consecutiveErrors = 0;

  function reset(): void {
    consecutiveErrors = 0;
  }

  function on<T>(name: string, dispatch?: (data: T) => void): void {
    source.addEventListener(name, (event) => {
      reset();
      dispatch?.(JSON.parse((event as MessageEvent).data) as T);
    });
  }

  source.addEventListener("open", reset);
  on("metrics", handlers.onMetrics);
  on("presence", handlers.onPresence);
  on("deploy", handlers.onDeploy);
  source.addEventListener("error", () => {
    consecutiveErrors++;
    // A closed source won't reconnect — a fatal response (503 over capacity, a
    // non-event-stream body) fires one error then stops, so fall back now
    // rather than waiting for a reconnect streak that never arrives.
    if (
      source.readyState === SOURCE_CLOSED ||
      consecutiveErrors === DOWN_AFTER_ERRORS
    ) {
      handlers.onDown?.();
    }
  });

  return () => source.close();
}
