import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SseHub } from "../sse.js";

export interface EventsRouteDeps {
  hub: SseHub;
  latestMetrics: () => unknown | null;
}

export function eventsRoute(deps: EventsRouteDeps): Hono {
  const { hub, latestMetrics } = deps;
  const app = new Hono();

  app.get("/api/events", (c) => {
    if (hub.atCapacity()) {
      c.header("Retry-After", "30");
      return c.text("", 503);
    }

    return streamSSE(c, async (stream) => {
      let live = true;
      stream.onAbort(() => {
        live = false;
      });

      const remove = hub.add({
        send(event, data) {
          void stream.writeSSE({ event, data });
        },
        close() {
          live = false;
          void stream.close();
        },
      });

      await stream.writeSSE({
        event: "presence",
        data: JSON.stringify({ count: hub.count }),
        retry: 5000,
      });

      const metrics = latestMetrics();
      if (metrics !== null) {
        await stream.writeSSE({
          event: "metrics",
          data: JSON.stringify(metrics),
        });
      }

      // Comment lines (":" prefix) keep the connection alive through proxies
      // without surfacing as a named event on the client's EventSource.
      while (live && !stream.aborted) {
        await stream.sleep(hub.heartbeatMs);
        if (!live || stream.aborted) break;
        await stream.write(": heartbeat\n\n");
      }

      remove();
    });
  });

  return app;
}
