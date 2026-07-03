import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type AppDeps, buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDeploysDb, openSloDb } from "./db.js";
import { GithubCache } from "./github.js";
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

const ROLLUP_INTERVAL_MS = 3_600_000;

const config = loadConfig(process.env);
const startedAt = Date.now();

const deploysDb = openDeploysDb(join(config.dataDir, "deploys.db"));
const sloDb = openSloDb(join(config.dataDir, "slo.db"));

const hub = new SseHub({ maxConnections: config.sseMaxConnections });
const host = new HostSampler();
const prober = new SloProber({ db: sloDb });
const github = new GithubCache({ user: config.githubUser });
const requests = new RequestCounter();

const services: ServiceDef[] = [
  { name: "nginx", probeUrl: "http://nginx:80/" },
  { name: "api", probeUrl: "http://localhost:3000/api/healthz" },
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
  clearInterval(rollupTimer);
  server.close((err) => {
    deploysDb.close();
    sloDb.close();
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
