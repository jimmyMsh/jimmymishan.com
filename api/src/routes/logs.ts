import { Hono } from "hono";
import type { LogTail } from "../logs/listener.js";

export interface LogsRouteDeps {
  tail: LogTail | null;
}

export function logsRoutes(deps: LogsRouteDeps): Hono {
  const app = new Hono();

  app.get("/api/logs", (c) => {
    if (deps.tail === null) {
      return c.json({ error: "disabled" }, 503);
    }
    return c.json({ lines: deps.tail.recent() });
  });

  return app;
}
