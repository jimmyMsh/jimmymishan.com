export type SseEventName = "metrics" | "presence" | "deploy" | "log";

export interface SseClient {
  send(event: string, data: string): void;
  close(): void;
}

interface SseHubOptions {
  maxConnections: number;
  heartbeatMs?: number;
  presenceDebounceMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 25000;
const DEFAULT_PRESENCE_DEBOUNCE_MS = 1000;

export class SseHub {
  readonly heartbeatMs: number;
  private readonly maxConnections: number;
  private readonly presenceDebounceMs: number;
  private readonly clients = new Set<SseClient>();
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: SseHubOptions) {
    this.maxConnections = opts.maxConnections;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.presenceDebounceMs =
      opts.presenceDebounceMs ?? DEFAULT_PRESENCE_DEBOUNCE_MS;
  }

  get count(): number {
    return this.clients.size;
  }

  atCapacity(): boolean {
    return this.clients.size >= this.maxConnections;
  }

  add(client: SseClient): () => void {
    this.clients.add(client);
    this.schedulePresenceBroadcast();

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.clients.delete(client);
      this.schedulePresenceBroadcast();
    };
  }

  broadcast(event: SseEventName, data: unknown): void {
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      try {
        client.send(event, payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private schedulePresenceBroadcast(): void {
    if (this.presenceTimer) return;
    const timer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.broadcast("presence", { count: this.count });
    }, this.presenceDebounceMs);
    // Debounce timer must not keep the process alive on its own.
    timer.unref?.();
    this.presenceTimer = timer;
  }
}
