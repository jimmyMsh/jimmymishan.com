import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface HostSample {
  ts: number;
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  load1: number;
  load5: number;
  load15: number;
  uptime_s: number;
}

export interface HistoryPoint {
  ts: number;
  cpu_pct: number;
  mem_used_mb: number;
}

interface HostSamplerOptions {
  procDir?: string;
  intervalMs?: number;
  ringSize?: number;
  now?: () => number;
}

interface CpuTimes {
  total: number;
  busy: number;
}

const DEFAULT_PROC_DIR = "/proc";
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_RING_SIZE = 150;

// /proc/stat's aggregate line: "cpu  user nice system idle iowait irq softirq steal guest guest_nice".
// guest/guest_nice are already folded into user/nice on Linux, so they're excluded from the total.
function parseCpuLine(statText: string): CpuTimes {
  const line = statText.split("\n").find((l) => /^cpu\s+\d/.test(l));
  if (!line) throw new Error("no aggregate cpu line in /proc/stat");

  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (fields.length < 8 || fields.some((n) => Number.isNaN(n))) {
    throw new Error("malformed cpu line in /proc/stat");
  }
  const [user, nice, system, idle, iowait, irq, softirq, steal] = fields;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const busy = total - (idle + iowait);
  return { total, busy };
}

function matchKb(text: string, key: string): number {
  const match = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m"));
  if (!match) throw new Error(`missing ${key} in /proc/meminfo`);
  return Number(match[1]);
}

function parseMeminfo(text: string): { totalMb: number; usedMb: number } {
  const totalKb = matchKb(text, "MemTotal");
  const availableKb = matchKb(text, "MemAvailable");
  return {
    totalMb: Math.round(totalKb / 1024),
    usedMb: Math.round((totalKb - availableKb) / 1024),
  };
}

function parseLoadavg(text: string): {
  load1: number;
  load5: number;
  load15: number;
} {
  const [load1, load5, load15] = text
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(Number);
  if ([load1, load5, load15].some((n) => Number.isNaN(n))) {
    throw new Error("malformed /proc/loadavg");
  }
  return { load1, load5, load15 };
}

function parseUptime(text: string): number {
  const seconds = Number(text.trim().split(/\s+/)[0]);
  if (Number.isNaN(seconds)) throw new Error("malformed /proc/uptime");
  return Math.floor(seconds);
}

function cpuPctFromDelta(prev: CpuTimes, curr: CpuTimes): number {
  const deltaTotal = curr.total - prev.total;
  if (deltaTotal <= 0) return 0;
  return (100 * (curr.busy - prev.busy)) / deltaTotal;
}

export class HostSampler {
  private readonly procDir: string;
  private readonly intervalMs: number;
  private readonly ringSize: number;
  private readonly now: () => number;

  private timer: ReturnType<typeof setInterval> | undefined;
  private onSample: ((s: HostSample) => void) | undefined;
  private prevCpu: CpuTimes | undefined;
  private latestSample: HostSample | null = null;
  private samples: HostSample[] = [];

  constructor(opts: HostSamplerOptions = {}) {
    this.procDir = opts.procDir ?? DEFAULT_PROC_DIR;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
    this.now = opts.now ?? Date.now;
  }

  start(onSample?: (s: HostSample) => void): void {
    this.onSample = onSample;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  latest(): HostSample | null {
    return this.latestSample;
  }

  history(): HistoryPoint[] {
    return this.samples.map(({ ts, cpu_pct, mem_used_mb }) => ({
      ts,
      cpu_pct,
      mem_used_mb,
    }));
  }

  private tick(): void {
    let cpu: CpuTimes;
    let mem: { totalMb: number; usedMb: number };
    let load: { load1: number; load5: number; load15: number };
    let uptimeS: number;

    try {
      cpu = parseCpuLine(readFileSync(join(this.procDir, "stat"), "utf8"));
      mem = parseMeminfo(readFileSync(join(this.procDir, "meminfo"), "utf8"));
      load = parseLoadavg(readFileSync(join(this.procDir, "loadavg"), "utf8"));
      uptimeS = parseUptime(readFileSync(join(this.procDir, "uptime"), "utf8"));
    } catch {
      return; // missing/malformed /proc snapshot this tick — keep the last good sample
    }

    const cpuPct = this.prevCpu ? cpuPctFromDelta(this.prevCpu, cpu) : 0;
    this.prevCpu = cpu;

    const sample: HostSample = {
      ts: Math.floor(this.now() / 1000),
      cpu_pct: cpuPct,
      mem_used_mb: mem.usedMb,
      mem_total_mb: mem.totalMb,
      load1: load.load1,
      load5: load.load5,
      load15: load.load15,
      uptime_s: uptimeS,
    };

    this.latestSample = sample;
    this.samples.push(sample);
    if (this.samples.length > this.ringSize) this.samples.shift();
    this.onSample?.(sample);
  }
}
