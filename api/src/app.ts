import { Hono } from "hono";

const startedAt = Date.now();

export const app = new Hono();

app.get("/api/healthz", (c) =>
  c.json({
    status: "ok",
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    commit: process.env.COMMIT ?? "dev",
  }),
);
