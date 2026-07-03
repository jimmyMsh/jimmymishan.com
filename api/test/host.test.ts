import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HostSample, HostSampler } from "../src/metrics/host.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "proc");

function withTempProcDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "host-sampler-"));
  try {
    for (const name of ["meminfo", "loadavg", "uptime", "stat"]) {
      copyFileSync(join(FIXTURES_DIR, name), join(dir, name));
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("HostSampler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses fixture values exactly, one known number per field", () => {
    const onSample = vi.fn();
    const sampler = new HostSampler({ procDir: FIXTURES_DIR, now: () => 5000 });

    sampler.start(onSample);
    sampler.stop();

    expect(onSample).toHaveBeenCalledTimes(1);
    expect(onSample.mock.calls[0][0]).toEqual({
      ts: 5,
      cpu_pct: 0,
      mem_used_mb: 6000,
      mem_total_mb: 8000,
      load1: 0.1,
      load5: 0.2,
      load15: 0.3,
      uptime_s: 123456,
    });
  });

  it("computes cpu_pct across two stat fixtures matching a hand-computed delta", () => {
    withTempProcDir((dir) => {
      // stat: total 1000, busy 200. stat-tick2: total 2000, busy 350.
      // delta busy 150 / delta total 1000 * 100 = 15.
      let now = 0;
      const samples: HostSample[] = [];
      const sampler = new HostSampler({
        procDir: dir,
        intervalMs: 1000,
        now: () => now,
      });

      sampler.start((s) => samples.push(s));
      copyFileSync(join(FIXTURES_DIR, "stat-tick2"), join(dir, "stat"));
      now = 1000;
      vi.advanceTimersByTime(1000);
      sampler.stop();

      expect(samples).toHaveLength(2);
      expect(samples[0].cpu_pct).toBe(0);
      expect(samples[1].cpu_pct).toBe(15);
    });
  });

  it("overwrites the oldest entry once history exceeds ringSize", () => {
    let now = 0;
    const sampler = new HostSampler({
      procDir: FIXTURES_DIR,
      intervalMs: 1000,
      ringSize: 3,
      now: () => now,
    });

    sampler.start();
    for (let i = 1; i <= 3; i++) {
      now = i * 1000;
      vi.advanceTimersByTime(1000);
    }
    sampler.stop();

    expect(sampler.history().map((p) => p.ts)).toEqual([1, 2, 3]);
  });

  it("fires onSample immediately on start, before any timer advance", () => {
    const onSample = vi.fn();
    const sampler = new HostSampler({
      procDir: FIXTURES_DIR,
      intervalMs: 5000,
    });

    sampler.start(onSample);

    expect(onSample).toHaveBeenCalledTimes(1);
    sampler.stop();
  });

  it("stops ticking once stop() is called", () => {
    const onSample = vi.fn();
    const sampler = new HostSampler({
      procDir: FIXTURES_DIR,
      intervalMs: 1000,
    });

    sampler.start(onSample);
    vi.advanceTimersByTime(3000);
    const callsBeforeStop = onSample.mock.calls.length;

    sampler.stop();
    vi.advanceTimersByTime(5000);

    expect(onSample.mock.calls.length).toBe(callsBeforeStop);
  });

  it("survives a missing proc directory without throwing, leaving latest() null", () => {
    const sampler = new HostSampler({
      procDir: join(tmpdir(), "host-sampler-does-not-exist"),
    });

    expect(() => sampler.start()).not.toThrow();
    expect(sampler.latest()).toBeNull();
    sampler.stop();
  });

  it("keeps the previous sample when a later tick hits a malformed proc file", () => {
    withTempProcDir((dir) => {
      const sampler = new HostSampler({
        procDir: dir,
        intervalMs: 1000,
        now: () => 42,
      });

      sampler.start();
      const firstLatest = sampler.latest();
      expect(firstLatest).not.toBeNull();

      writeFileSync(join(dir, "stat"), "not a proc stat file\n");
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

      expect(sampler.latest()).toEqual(firstLatest);
      sampler.stop();
    });
  });
});
