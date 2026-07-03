import type { DatabaseSync } from "node:sqlite";

export interface ProbeResult {
  ts: number;
  ok: boolean;
  latency_ms: number;
}

interface SloProberOptions {
  db: DatabaseSync;
  url?: string;
  intervalMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

const DEFAULT_URL = "http://nginx:80/";
const DEFAULT_INTERVAL_MS = 60000;

export class SloProber {
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly insert: ReturnType<DatabaseSync["prepare"]>;

  private timer: ReturnType<typeof setInterval> | undefined;
  private latestLatency: number | null = null;
  private running = false;

  constructor(opts: SloProberOptions) {
    this.url = opts.url ?? DEFAULT_URL;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.insert = opts.db.prepare(
      "INSERT OR REPLACE INTO probes (ts, ok, latency_ms) VALUES (?, ?, ?)",
    );
  }

  start(onProbe?: (p: ProbeResult) => void): void {
    this.running = true;
    void this.tick(onProbe);
    this.timer = setInterval(() => void this.tick(onProbe), this.intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  latestLatencyMs(): number | null {
    return this.latestLatency;
  }

  private async tick(onProbe?: (p: ProbeResult) => void): Promise<void> {
    const startMs = this.now();
    let ok = false;
    try {
      const res = await this.fetchFn(this.url);
      // Drain the body regardless of status so undici frees the socket; success
      // is a clean 200 with the body fully received, which is what latency times.
      await res.arrayBuffer();
      ok = res.status === 200;
    } catch {
      ok = false;
    }
    // Ignore a probe that resolved after stop() — its timer is already gone.
    if (!this.running) return;

    const latencyMs = Math.max(0, Math.round(this.now() - startMs));
    const ts = Math.floor(startMs / 1000);

    this.insert.run(ts, ok ? 1 : 0, latencyMs);
    this.latestLatency = latencyMs;
    onProbe?.({ ts, ok, latency_ms: latencyMs });
  }
}
