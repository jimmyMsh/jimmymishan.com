import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AppDeps, buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDeploysDb, openGuestbookDb, openSloDb } from "./db.js";
import { GithubCache } from "./github.js";
import { loadGeo } from "./logs/geo.js";
import { LogTail } from "./logs/listener.js";
import {
  type ContainerStat,
  ContainerStats,
  type ServiceDef,
} from "./metrics/cgroup.js";
import { type HostSample, HostSampler } from "./metrics/host.js";
import { RequestCounter } from "./routes/metrics.js";
import { SloProber } from "./slo/probe.js";
import { rollup } from "./slo/rollup.js";
import { SseHub } from "./sse.js";
import { DailyCaps, WriteCounters } from "./writes/gate.js";

const ROLLUP_INTERVAL_MS = 3_600_000;
// Container-internal UDP port NGINX's syslog access_log target points at
// (never published outside the compose network — see nginx config).
const LOG_TAIL_PORT = 5140;
// Baked into the image at build time by a later CI stage; dev builds may lack
// the file, in which case loadGeo degrades to a constant "--" lookup.
const GEO_DB_PATH = "api/geo/dbip-country-lite.mmdb";
// Contact's global cap is stricter than guestbook's: it lands in a single
// Discord inbox rather than a public page, so it tolerates less daily volume.
const GUESTBOOK_CAPS = { perIp: 3, global: 30 };
const CONTACT_CAPS = { perIp: 3, global: 15 };

const config = loadConfig(process.env);
const startedAt = Date.now();

const deploysDb = openDeploysDb(join(config.dataDir, "deploys.db"));
const sloDb = openSloDb(join(config.dataDir, "slo.db"));
const guestbookDb = openGuestbookDb(join(config.dataDir, "guestbook.db"));

const hub = new SseHub({ maxConnections: config.sseMaxConnections });
const host = new HostSampler();
const prober = new SloProber({ db: sloDb });
const github = new GithubCache({ user: config.githubUser });
const requests = new RequestCounter();

// Tokens are stateless HMACs, so a secret that changes on every restart just
// invalidates tokens already in flight; that's an acceptable trade-off for
// never persisting the fallback secret to disk.
const writeSecret = config.writeSecret ?? randomBytes(32).toString("hex");
if (config.writeSecret === null) {
  console.warn(
    "WRITE_SECRET not set; using a random per-boot secret (write tokens will not survive a restart)",
  );
}
const guestbookCaps = new DailyCaps(
  GUESTBOOK_CAPS.perIp,
  GUESTBOOK_CAPS.global,
);
const contactCaps = new DailyCaps(CONTACT_CAPS.perIp, CONTACT_CAPS.global);
const writeCounters = new WriteCounters();

let logTail: LogTail | null = null;
if (config.logTailEnabled) {
  const geo = loadGeo(GEO_DB_PATH);
  logTail = new LogTail({
    hub,
    geo,
    allowPrivate: config.logTailAllowPrivate,
  });
  logTail.start(LOG_TAIL_PORT);
}

const services: ServiceDef[] = [
  { name: "nginx", probeUrl: "http://nginx:80/" },
  { name: "api", probeUrl: "http://localhost:3000/api/healthz" },
  { name: "goatcounter", probeUrl: "http://goatcounter:8080/" },
];
const containerStats = new ContainerStats({
  services,
  probe: async (url) => {
    try {
      return (await fetch(url)).ok;
    } catch {
      return false;
    }
  },
});

// Shared holders the routes read from: `latestContainers` feeds /api/status
// and /api/metrics; `latestMetrics` is the exact frame both the SSE broadcast
// and /api/events' on-connect frame send, so the two are byte-identical.
let latestContainers: ContainerStat[] = [];
let latestMetrics: unknown | null = null;

function composeMetrics(sample: HostSample): unknown {
  return {
    ts: sample.ts,
    host: {
      cpu_pct: sample.cpu_pct,
      mem_used_mb: sample.mem_used_mb,
      mem_total_mb: sample.mem_total_mb,
      load1: sample.load1,
    },
    containers: latestContainers,
    probe_ms: prober.latestLatencyMs(),
  };
}

const deploysTotalStmt = deploysDb.prepare("SELECT COUNT(*) AS n FROM deploys");

const deps: AppDeps = {
  config,
  host,
  containers: () => latestContainers,
  hub,
  deploysDb,
  sloDb,
  startedAt,
  latestMetrics: () => latestMetrics,
  github,
  requests,
  prober,
  deploysTotal: () => Number((deploysTotalStmt.get() as { n: number }).n),
  guestbook: {
    db: guestbookDb,
    secret: writeSecret,
    enabled: config.guestbookEnabled,
    caps: guestbookCaps,
    counters: writeCounters,
  },
  contact: {
    webhookUrl: config.contactDiscordWebhook,
    secret: writeSecret,
    caps: contactCaps,
    counters: writeCounters,
  },
  logTail,
  writeSecret,
  writeCounters,
};

const app = buildApp(deps);

const server = serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`api listening on :${info.port}`);
});

host.start((sample) => {
  latestMetrics = composeMetrics(sample);
  hub.broadcast("metrics", latestMetrics);
  void containerStats.sample().then((stats) => {
    latestContainers = stats;
  });
});
prober.start();
github.start();
const rollupTimer = setInterval(() => {
  rollup(sloDb, Math.floor(Date.now() / 1000));
}, ROLLUP_INTERVAL_MS);

const shutdown = () => {
  host.stop();
  prober.stop();
  github.stop();
  logTail?.stop();
  clearInterval(rollupTimer);
  server.close((err) => {
    deploysDb.close();
    sloDb.close();
    guestbookDb.close();
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Live SSE streams never drain on their own (heartbeats keep them open), so
  // close() would wait forever; force sockets shut so the callback above runs.
  // The `in` guard narrows serve()'s Server|Http2Server union to plain http,
  // which is what we always run here.
  if ("closeAllConnections" in server) server.closeAllConnections();
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
