import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiStatus, DeployRecord } from "../api/types";
import { TEASERS } from "./flavor";
import {
  formatDeployLines,
  formatDockerLines,
  formatFreeLines,
  formatStatusLines,
  formatUptimeLine,
  registerLiveCommands,
} from "./live";
import { CommandRegistry, execute } from "./registry";
import type { CommandContext, Line } from "./types";
import { createVfs } from "./vfs";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const DEPLOY_AT = 1751454180;

const FIXTURE_STATUS: ApiStatus = {
  host: {
    cpu_pct: 7.1,
    mem_used_mb: 312,
    mem_total_mb: 957,
    load1: 0.12,
    load5: 0.08,
    load15: 0.05,
    uptime_s: 1050300,
  },
  history: [],
  containers: [
    { name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 },
    { name: "api", up: false, cpu_pct: null, mem_mb: null },
  ],
  deploy: { sha: "c584a9e", tag: "c584a9e", status: "ok", at: DEPLOY_AT },
  presence: 3,
  slo: {
    window_days: 90,
    availability_pct: 99.98,
    p50_ms: 42,
    p99_ms: 180,
    days: [],
    recent: [],
  },
  commit: "c584a9e",
  api_uptime_s: 4242,
};

const NOW = new Date((DEPLOY_AT + 3 * 3600) * 1000);

const FIXTURE_DEPLOYS: DeployRecord[] = [
  {
    sha: "c584a9e",
    tag: "c584a9e",
    status: "ok",
    actor: "jimmyMsh",
    at: DEPLOY_AT,
  },
  {
    sha: "a1b2c3d",
    tag: null,
    status: "failed",
    actor: null,
    at: DEPLOY_AT - 86400,
  },
];

function textOf(lines: Line[]): string {
  return lines.map((l) => l.segments.map((s) => s.text).join("")).join("\n");
}

function makeCtx(): { ctx: CommandContext; lines: Line[] } {
  const lines: Line[] = [];
  const ctx: CommandContext = {
    writer: {
      writeLine: (l) => lines.push(l),
      replaceLast: (count, next) => lines.splice(-count, count, ...next),
      clear: () => lines.splice(0),
    },
    vfs: createVfs([]),
    navigate: () => {},
    historyList: () => [],
    reducedMotion: true,
    signal: new AbortController().signal,
    now: () => NOW,
  };
  return { ctx, lines };
}

function makeRegistry(fetchFn: typeof fetch): CommandRegistry {
  const reg = new CommandRegistry(TEASERS);
  registerLiveCommands(reg, { fetchFn });
  return reg;
}

describe("formatters", () => {
  it("formatUptimeLine reads like the classic one-liner", () => {
    const line = formatUptimeLine(FIXTURE_STATUS, NOW);
    expect(textOf([line])).toBe(
      "14:03:00 up 12 days, 3:45, load average: 0.12, 0.08, 0.05",
    );
  });

  it("formatFreeLines renders a two-row MiB table", () => {
    const lines = formatFreeLines(FIXTURE_STATUS);
    expect(textOf(lines)).toBe(
      "            total       used       free  available\n" +
        "Mem:          957        312        645        645",
    );
  });

  it("formatDockerLines shows dash columns for degraded containers", () => {
    const lines = formatDockerLines(FIXTURE_STATUS);
    expect(textOf(lines)).toBe(
      "NAME      STATUS   CPU     MEM\n" +
        "nginx     up       0.1%    12 MiB\n" +
        "api       down     -       -",
    );
  });

  it("formatDeployLines shows relative and absolute times plus a hint", () => {
    const lines = formatDeployLines(FIXTURE_DEPLOYS, NOW);
    expect(textOf(lines)).toBe(
      "c584a9e  ok  3h ago (2025-07-02 11:03 UTC)\n" +
        "a1b2c3d  failed  1d ago (2025-07-01 11:03 UTC)\n" +
        "# see the full feed at /status",
    );
    expect(lines.at(-1)?.kind).toBe("hint");
  });

  it("formatStatusLines includes presence, availability, and a /status link", () => {
    const lines = formatStatusLines(FIXTURE_STATUS, NOW);
    const out = textOf(lines);
    expect(out).toContain(
      "host: cpu 7.1% · mem 312/957 MiB · load 0.12 0.08 0.05 · up 12 days, 3:45",
    );
    expect(out).toContain("containers: nginx up (0.1% · 12 MiB) · api down");
    expect(out).toContain("last deploy: c584a9e ok · 3h ago");
    expect(out).toContain("presence: 3 here now");
    expect(out).toContain(
      "uptime (90d window): 99.98% avail · p50 42ms · p99 180ms",
    );
    const last = lines.at(-1);
    expect(last?.segments.some((s) => s.href === "/status")).toBe(true);
  });
});

describe("registerLiveCommands", () => {
  it("registers all six live commands, replacing every teaser", () => {
    const reg = makeRegistry(() =>
      Promise.resolve(jsonResponse(FIXTURE_STATUS)),
    );
    for (const name of [
      "status",
      "uptime",
      "free",
      "docker",
      "deploys",
      "top",
    ]) {
      expect(reg.get(name)).toBeDefined();
      expect(reg.teaser(name)).toBeUndefined();
    }
  });

  it("uptime no longer teases and prints live output", async () => {
    const reg = makeRegistry(() =>
      Promise.resolve(jsonResponse(FIXTURE_STATUS)),
    );
    const { ctx, lines } = makeCtx();
    await execute(reg, "uptime", ctx);
    const out = textOf(lines);
    expect(out).not.toContain("not wired up yet");
    expect(out).toContain("up 12 days");
  });

  it("deploys fetches /api/deploys with a limit of 10", async () => {
    const fetchFn = vi.fn((path: string) => {
      expect(path).toBe("/api/deploys?limit=10");
      return Promise.resolve(jsonResponse({ deploys: FIXTURE_DEPLOYS }));
    });
    const reg = makeRegistry(fetchFn as unknown as typeof fetch);
    const { ctx, lines } = makeCtx();
    await execute(reg, "deploys", ctx);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(textOf(lines)).toContain("c584a9e  ok  3h ago");
  });

  it("prints the exact unreachable line and exits cleanly on ApiError", async () => {
    const reg = makeRegistry(() => Promise.resolve(jsonResponse({}, 503)));
    for (const name of ["status", "uptime", "free", "docker", "deploys"]) {
      const { ctx, lines } = makeCtx();
      await execute(reg, name, ctx);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.kind).toBe("error");
      expect(textOf(lines)).toBe(
        `${name}: can't reach the api — try the dashboard at /status`,
      );
    }
  });

  it("swallows ctrl+c on status instead of reporting it unreachable", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const reg = makeRegistry(fetchFn as unknown as typeof fetch);
    const { ctx, lines } = makeCtx();
    const run = execute(reg, "status", { ...ctx, signal: controller.signal });
    controller.abort();
    await run;
    expect(lines).toHaveLength(0);
  });

  it("swallows ctrl+c on deploys instead of reporting it unreachable", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
    const reg = makeRegistry(fetchFn as unknown as typeof fetch);
    const { ctx, lines } = makeCtx();
    const run = execute(reg, "deploys", {
      ...ctx,
      signal: controller.signal,
    });
    controller.abort();
    await run;
    expect(lines).toHaveLength(0);
  });
});

describe("prefetchStatus", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the fetched status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS))),
    );
    vi.resetModules();
    const { prefetchStatus: fresh } = await import("./live");
    await expect(fresh()).resolves.toEqual(FIXTURE_STATUS);
  });

  it("memoizes across calls instead of refetching", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS)));
    vi.stubGlobal("fetch", fetchFn);
    vi.resetModules();
    const { prefetchStatus: fresh } = await import("./live");
    await fresh();
    await fresh();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("resolves null on failure instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("boom"))),
    );
    vi.resetModules();
    const { prefetchStatus: fresh } = await import("./live");
    await expect(fresh()).resolves.toBeNull();
  });
});

describe("status reuses the page-load prefetch on first use", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function freshRegistry(
    fetchFn: typeof fetch,
  ): Promise<CommandRegistry> {
    vi.resetModules();
    const live = await import("./live");
    const reg = new CommandRegistry(TEASERS);
    live.registerLiveCommands(reg, { fetchFn });
    return reg;
  }

  it("first status renders the memoized prefetch without a fresh fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS))),
    );
    const fresh = vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS)));
    const reg = await freshRegistry(fresh as unknown as typeof fetch);
    const { ctx, lines } = makeCtx();

    await execute(reg, "status", ctx);

    expect(fresh).not.toHaveBeenCalled();
    expect(textOf(lines)).toContain("host: cpu 7.1%");
  });

  it("fetches fresh on the second status once the prefetch is consumed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS))),
    );
    const fresh = vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS)));
    const reg = await freshRegistry(fresh as unknown as typeof fetch);

    await execute(reg, "status", makeCtx().ctx);
    await execute(reg, "status", makeCtx().ctx);

    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("falls through to a fresh fetch when the prefetch resolved null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("boom"))),
    );
    const fresh = vi.fn(() => Promise.resolve(jsonResponse(FIXTURE_STATUS)));
    const reg = await freshRegistry(fresh as unknown as typeof fetch);
    const { ctx, lines } = makeCtx();

    await execute(reg, "status", ctx);

    expect(fresh).toHaveBeenCalledTimes(1);
    expect(textOf(lines)).toContain("host: cpu 7.1%");
  });
});
