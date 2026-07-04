export interface HostStatus {
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  load1: number;
  load5: number;
  load15: number;
  uptime_s: number;
}

export interface HistoryPoint {
  /** epoch seconds */
  ts: number;
  cpu_pct: number;
  mem_used_mb: number;
}

export interface ContainerStatus {
  name: string;
  up: boolean;
  cpu_pct: number | null;
  mem_mb: number | null;
}

export interface StatusDeploy {
  sha: string;
  tag: string | null;
  status: "ok" | "failed";
  at: number;
}

export interface SloDay {
  day: string;
  availability_pct: number;
  p95_ms: number;
}

export interface SloRecentProbe {
  ts: number;
  latency_ms: number;
}

export interface SloBlock {
  window_days: number;
  availability_pct: number;
  p50_ms: number;
  p99_ms: number;
  days: SloDay[];
  recent: SloRecentProbe[];
}

export interface ApiStatus {
  host: HostStatus;
  history: HistoryPoint[];
  containers: ContainerStatus[];
  deploy: StatusDeploy | null;
  presence: number;
  slo: SloBlock | null;
  commit: string;
  api_uptime_s: number;
}

export interface MetricsEventData {
  /** epoch seconds */
  ts: number;
  host: {
    cpu_pct: number;
    mem_used_mb: number;
    mem_total_mb: number;
    load1: number;
  };
  containers: Array<{
    name: string;
    up: boolean;
    cpu_pct: number | null;
    mem_mb: number | null;
  }>;
  probe_ms: number | null;
}

export interface GithubRepo {
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  pushed_at: string;
  url: string;
  fork: boolean;
}

export interface GithubResponse {
  fetched_at: number | null;
  repos: GithubRepo[];
}

export interface DeployRecord {
  sha: string;
  tag: string | null;
  status: "ok" | "failed";
  actor: string | null;
  at: number;
}

export interface DeploysResponse {
  deploys: DeployRecord[];
}

export interface GuestbookEntry {
  id: number;
  name: string;
  message: string;
  /** epoch seconds */
  ts: number;
}

export interface GuestbookResponse {
  entries: GuestbookEntry[];
  token: string;
}

export interface TokenResponse {
  token: string;
}
