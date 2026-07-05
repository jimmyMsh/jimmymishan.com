import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContainerStats, type ServiceDef } from "../src/metrics/cgroup.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "cgroup");

async function withTempCgroup(
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cgroup-"));
  cpSync(FIXTURES_DIR, dir, { recursive: true });
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const services: ServiceDef[] = [
  { name: "nginx", probeUrl: "http://nginx:80/" },
  { name: "api", probeUrl: "http://api:3000/api/healthz" },
];

describe("ContainerStats", () => {
  it("resolves both services with mem_mb and a two-sample cpu_pct delta", async () => {
    await withTempCgroup(async (dir) => {
      let now = 1000;
      const stats = new ContainerStats({
        cgroupDir: dir,
        services,
        now: () => now,
      });

      const first = await stats.sample();
      expect(first).toEqual([
        { name: "nginx", up: true, cpu_pct: null, mem_mb: 13 },
        { name: "api", up: true, cpu_pct: null, mem_mb: 6 },
      ]);

      // Advance usage_usec 2000ms later: nginx +200000, api +150000.
      writeFileSync(
        join(dir, "nginx.slice", "childa", "cpu.stat"),
        "usage_usec 1200000\n",
      );
      writeFileSync(
        join(dir, "api.slice", "childb", "cpu.stat"),
        "usage_usec 650000\n",
      );
      now = 3000;

      const second = await stats.sample();
      // cpu_pct = 100 * Δusage_usec / (Δwall_ms * 1000)
      expect(second).toEqual([
        { name: "nginx", up: true, cpu_pct: 10, mem_mb: 13 },
        { name: "api", up: true, cpu_pct: 7.5, mem_mb: 6 },
      ]);
    });
  });

  it("reports cpu_pct null on the first sample of a resolved service", async () => {
    const stats = new ContainerStats({
      cgroupDir: FIXTURES_DIR,
      services: [{ name: "nginx" }],
      now: () => 1000,
    });

    const [nginx] = await stats.sample();
    expect(nginx).toEqual({
      name: "nginx",
      up: true,
      cpu_pct: null,
      mem_mb: 13,
    });
  });

  it("degrades an unresolvable service to probe liveness when the probe passes", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const stats = new ContainerStats({
      cgroupDir: FIXTURES_DIR,
      services: [{ name: "missing", probeUrl: "http://missing/" }],
      probe,
    });

    const [svc] = await stats.sample();
    expect(svc).toEqual({
      name: "missing",
      up: true,
      cpu_pct: null,
      mem_mb: null,
    });
    expect(probe).toHaveBeenCalledWith("http://missing/");
  });

  it("marks an unresolvable service down when the probe fails", async () => {
    const stats = new ContainerStats({
      cgroupDir: FIXTURES_DIR,
      services: [{ name: "missing", probeUrl: "http://missing/" }],
      probe: async () => false,
    });

    const [svc] = await stats.sample();
    expect(svc).toEqual({
      name: "missing",
      up: false,
      cpu_pct: null,
      mem_mb: null,
    });
  });

  it("marks an unresolvable service without a probeUrl down without probing", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const stats = new ContainerStats({
      cgroupDir: FIXTURES_DIR,
      services: [{ name: "missing" }],
      probe,
    });

    const [svc] = await stats.sample();
    expect(svc).toEqual({
      name: "missing",
      up: false,
      cpu_pct: null,
      mem_mb: null,
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("degrades when the slice exists but holds no child scope", async () => {
    await withTempCgroup(async (dir) => {
      // A lingering, empty parent slice (container exited) has no child scope dir.
      rmSync(join(dir, "nginx.slice", "childa"), {
        recursive: true,
        force: true,
      });
      const probe = vi.fn().mockResolvedValue(true);
      const stats = new ContainerStats({
        cgroupDir: dir,
        services: [{ name: "nginx", probeUrl: "http://nginx/" }],
        probe,
      });

      const [svc] = await stats.sample();
      expect(svc).toEqual({
        name: "nginx",
        up: true,
        cpu_pct: null,
        mem_mb: null,
      });
      expect(probe).toHaveBeenCalledOnce();
    });
  });
});
