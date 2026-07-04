import type { DeployRecord, LogEventData, MetricsEventData } from "./types";

export class ApiError extends Error {
  readonly kind: "timeout" | "network" | "http";
  readonly status?: number;
  /** parsed from a JSON {"error": code} non-2xx body, else undefined */
  readonly code?: string;
  /** parsed from that same body's optional "field", else undefined */
  readonly field?: string;

  constructor(
    kind: "timeout" | "network" | "http",
    message: string,
    status?: number,
    code?: string,
    field?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export interface ApiFetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  method?: "GET" | "POST";
  body?: unknown;
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(`http ${status}`);
  }
}

// Non-2xx bodies aren't guaranteed to be JSON (or to be our own write-endpoint
// shape) — swallow parse failures rather than misreporting them as a network
// error.
async function parseErrorBody(
  res: Response,
): Promise<{ code?: string; field?: string }> {
  try {
    const body = (await res.json()) as { error?: unknown; field?: unknown };
    return {
      code: typeof body.error === "string" ? body.error : undefined,
      field: typeof body.field === "string" ? body.field : undefined,
    };
  } catch {
    return {};
  }
}

export async function apiFetch<T>(
  path: string,
  opts: ApiFetchOptions = {},
): Promise<T> {
  const {
    timeoutMs = 3000,
    signal: external,
    fetchFn = fetch,
    method = "GET",
    body,
  } = opts;
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

  const init: RequestInit = { signal: combined, method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  try {
    const fetchPromise = fetchFn(path, init);
    fetchPromise.catch(() => {});
    const res = await Promise.race([fetchPromise, aborted]);
    if (!res.ok) {
      const { code, field } = await parseErrorBody(res);
      throw new HttpStatusError(res.status, code, field);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof HttpStatusError) {
      throw new ApiError(
        "http",
        `${path}: http ${err.status}`,
        err.status,
        err.code,
        err.field,
      );
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
  onLog?(data: LogEventData): void;
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
  on("log", handlers.onLog);
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
