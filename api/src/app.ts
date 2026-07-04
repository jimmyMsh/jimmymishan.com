import { Hono } from "hono";
import type { GithubCache } from "./github.js";
import type { LogTail } from "./logs/listener.js";
import type { ContactDeps } from "./routes/contact.js";
import { contactRoutes } from "./routes/contact.js";
import { deploysRoutes } from "./routes/deploys.js";
import { eventsRoute } from "./routes/events.js";
import { githubRoute } from "./routes/github.js";
import type { GuestbookDeps } from "./routes/guestbook.js";
import { guestbookRoutes } from "./routes/guestbook.js";
import { logsRoutes } from "./routes/logs.js";
import type { RequestCounter } from "./routes/metrics.js";
import { metricsRoute } from "./routes/metrics.js";
import type { StatusDeps } from "./routes/status.js";
import { statusRoute } from "./routes/status.js";
import { tokenRoute } from "./routes/token.js";
import type { SloProber } from "./slo/probe.js";
import type { WriteCounters } from "./writes/gate.js";

export interface AppDeps extends StatusDeps {
  latestMetrics: () => unknown | null;
  github: GithubCache;
  requests: RequestCounter;
  prober: SloProber;
  deploysTotal: () => number;
  guestbook: GuestbookDeps;
  contact: ContactDeps;
  logTail: LogTail | null;
  writeSecret: string;
  writeCounters: WriteCounters;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Registered before the routes so it wraps every matched handler; the
  // counter reads the route pattern via routePath, which only resolves once
  // a route has matched further down the chain.
  app.use(deps.requests.middleware());

  app.get("/api/healthz", (c) =>
    c.json({
      status: "ok",
      uptime_s: Math.round(
        ((deps.now?.() ?? Date.now()) - deps.startedAt) / 1000,
      ),
      commit: deps.config.commit,
    }),
  );

  app.route("/", statusRoute(deps));
  app.route(
    "/",
    eventsRoute({ hub: deps.hub, latestMetrics: deps.latestMetrics }),
  );
  app.route("/", githubRoute({ cache: deps.github }));
  // deploysRoutes owns its own unix-seconds clock; AppDeps.now is milliseconds
  // (Date.now) for the status/metrics blocks, so it must not be forwarded here.
  app.route(
    "/",
    deploysRoutes({
      db: deps.deploysDb,
      secret: deps.config.deployWebhookSecret,
      hub: deps.hub,
    }),
  );
  app.route("/", metricsRoute(deps));

  app.route("/", tokenRoute({ secret: deps.writeSecret }));
  app.route("/", guestbookRoutes(deps.guestbook));
  app.route("/", contactRoutes(deps.contact));
  app.route("/", logsRoutes({ tail: deps.logTail }));

  return app;
}
