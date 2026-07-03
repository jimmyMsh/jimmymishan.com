import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Config } from "../config.js";
import type { ContainerStat } from "../metrics/cgroup.js";
import type { HostSample, HostSampler } from "../metrics/host.js";
import { sloBlock } from "../slo/rollup.js";
import type { SseHub } from "../sse.js";

export interface StatusDeps {
  config: Config;
  host: HostSampler;
  containers: () => ContainerStat[];
  hub: SseHub;
  deploysDb: DatabaseSync;
  sloDb: DatabaseSync;
  startedAt: number;
  now?: () => number;
}

interface DeployBlock {
  sha: string;
  tag: string | null;
  status: "ok" | "failed";
  at: number;
}

// `type` (not `interface`) so this compares structurally against the SQLite
// row shape (Record<string, SQLOutputValue>) when cast below.
type DeployRow = {
  sha: string;
  tag: string | null;
  status: string;
  ts: number;
};

const ZERO_HOST: Omit<HostSample, "ts"> = {
  cpu_pct: 0,
  mem_used_mb: 0,
  mem_total_mb: 0,
  load1: 0,
  load5: 0,
  load15: 0,
  uptime_s: 0,
};

function hostBlock(sample: HostSample | null): Omit<HostSample, "ts"> {
  if (!sample) return ZERO_HOST;
  const { ts: _ts, ...rest } = sample;
  return rest;
}

function latestDeploy(db: DatabaseSync): DeployBlock | null {
  const row = db
    .prepare(
      "SELECT sha, tag, status, ts FROM deploys ORDER BY ts DESC LIMIT 1",
    )
    .get() as DeployRow | undefined;
  if (!row) return null;

  return {
    sha: row.sha,
    tag: row.tag,
    status: row.status === "failed" ? "failed" : "ok",
    at: row.ts,
  };
}

export function statusRoute(deps: StatusDeps): Hono {
  const now = deps.now ?? Date.now;
  const app = new Hono();

  app.get("/api/status", (c) => {
    const nowSec = Math.floor(now() / 1000);

    return c.json({
      host: hostBlock(deps.host.latest()),
      history: deps.host.history(),
      containers: deps.containers(),
      deploy: latestDeploy(deps.deploysDb),
      presence: deps.hub.count,
      slo: sloBlock(deps.sloDb, nowSec),
      commit: deps.config.commit,
      api_uptime_s: Math.round((now() - deps.startedAt) / 1000),
    });
  });

  return app;
}
