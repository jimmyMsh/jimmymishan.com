import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ServiceDef {
  name: string;
  probeUrl?: string;
}

export interface ContainerStat {
  name: string;
  up: boolean;
  cpu_pct: number | null;
  mem_mb: number | null;
}

interface ContainerStatsOptions {
  cgroupDir?: string;
  services: ServiceDef[];
  probe?: (url: string) => Promise<boolean>;
  now?: () => number;
}

interface CgroupReading {
  usageUsec: number;
  memBytes: number;
}

interface PrevSample {
  usageUsec: number;
  wallMs: number;
}

const DEFAULT_CGROUP_DIR = "/host/cgroup";
const BYTES_PER_MIB = 1024 * 1024;

function parseUsageUsec(cpuStat: string): number {
  const match = cpuStat.match(/^usage_usec\s+(\d+)/m);
  if (!match) throw new Error("no usage_usec in cpu.stat");
  return Number(match[1]);
}

// Each service gets its own compose `cgroup_parent` slice under cgroupDir,
// named `<service>.slice` — the systemd cgroup driver rejects parents without
// the .slice suffix, and the cgroupfs driver accepts them, so the suffix keeps
// one name valid on both. A running container is the single child scope dir
// inside it; the slice lingers empty once the container exits, so an absent
// child scope — not an absent slice — is what marks the service down.
function readServiceCgroup(sliceDir: string): CgroupReading {
  const children = readdirSync(sliceDir, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  if (children.length === 0) throw new Error("slice has no child scope");

  let usageUsec = 0;
  let memBytes = 0;
  for (const child of children) {
    const scope = join(sliceDir, child.name);
    usageUsec += parseUsageUsec(readFileSync(join(scope, "cpu.stat"), "utf8"));
    memBytes += Number(
      readFileSync(join(scope, "memory.current"), "utf8").trim(),
    );
  }
  if (Number.isNaN(usageUsec) || Number.isNaN(memBytes)) {
    throw new Error("malformed cgroup accounting");
  }
  return { usageUsec, memBytes };
}

function cpuPct(
  prev: PrevSample | undefined,
  usageUsec: number,
  wallMs: number,
): number | null {
  if (!prev) return null;
  const deltaWallUsec = (wallMs - prev.wallMs) * 1000;
  const deltaUsage = usageUsec - prev.usageUsec;
  if (deltaWallUsec <= 0 || deltaUsage < 0) return null; // restart resets usage
  return (100 * deltaUsage) / deltaWallUsec;
}

export class ContainerStats {
  private readonly cgroupDir: string;
  private readonly services: ServiceDef[];
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly now: () => number;
  private readonly prev = new Map<string, PrevSample>();

  constructor(opts: ContainerStatsOptions) {
    this.cgroupDir = opts.cgroupDir ?? DEFAULT_CGROUP_DIR;
    this.services = opts.services;
    this.probe = opts.probe ?? (async () => false);
    this.now = opts.now ?? Date.now;
  }

  async sample(): Promise<ContainerStat[]> {
    return Promise.all(this.services.map((svc) => this.sampleService(svc)));
  }

  private async sampleService(svc: ServiceDef): Promise<ContainerStat> {
    let reading: CgroupReading;
    try {
      reading = readServiceCgroup(join(this.cgroupDir, `${svc.name}.slice`));
    } catch {
      this.prev.delete(svc.name);
      const up = svc.probeUrl ? await this.probe(svc.probeUrl) : false;
      return { name: svc.name, up, cpu_pct: null, mem_mb: null };
    }

    const wallMs = this.now();
    const pct = cpuPct(this.prev.get(svc.name), reading.usageUsec, wallMs);
    this.prev.set(svc.name, { usageUsec: reading.usageUsec, wallMs });
    return {
      name: svc.name,
      up: true,
      cpu_pct: pct,
      mem_mb: Math.round(reading.memBytes / BYTES_PER_MIB),
    };
  }
}
