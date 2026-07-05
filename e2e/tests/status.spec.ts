import { expect, type Route, test } from "@playwright/test";

// Snapshot shaped like GET /api/status. Values are chosen so the rendered
// numbers are exact and stable; the deploy timestamp is relative so the feed's
// "X ago" text stays fresh regardless of when the suite runs.
function statusFixture() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    host: {
      cpu_pct: 7.1,
      mem_used_mb: 312,
      mem_total_mb: 957,
      load1: 0.12,
      load5: 0.08,
      load15: 0.05,
      uptime_s: 1065432,
    },
    history: [
      { ts: nowSec - 4, cpu_pct: 6.9, mem_used_mb: 310 },
      { ts: nowSec - 2, cpu_pct: 7.1, mem_used_mb: 312 },
    ],
    containers: [
      { name: "nginx", up: true, cpu_pct: 0.1, mem_mb: 12 },
      { name: "api", up: true, cpu_pct: 2.3, mem_mb: 40 },
    ],
    deploy: {
      sha: "c584a9e",
      tag: "c584a9e",
      status: "ok",
      at: nowSec - 3 * 3600,
    },
    presence: 3,
    slo: {
      window_days: 90,
      availability_pct: 99.98,
      p50_ms: 42,
      p99_ms: 180,
      days: [
        { day: "2026-06-30", availability_pct: 100, p95_ms: 48 },
        { day: "2026-07-01", availability_pct: 99.5, p95_ms: 60 },
        { day: "2026-07-02", availability_pct: 98.0, p95_ms: 90 },
      ],
      recent: [
        { ts: nowSec - 120, latency_ms: 40 },
        { ts: nowSec - 60, latency_ms: 44 },
      ],
    },
    commit: "c584a9e0f1e2d3c4b5a69788766554433221100f",
    api_uptime_s: 4242,
  };
}

const json = (body: unknown) => ({
  contentType: "application/json",
  body: JSON.stringify(body),
});

// A 200 event-stream that opens cleanly and defers its reconnect far past the
// test, so the island treats the stream as up (no polling-fallback note) while
// nothing streams.
const quietStream = (route: Route) =>
  route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: "retry: 100000\n\n",
  });

test("first paint renders the mocked snapshot", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/status"))
      return route.fulfill(json(statusFixture()));
    if (url.includes("/api/events")) return quietStream(route);
    return route.fulfill({ status: 404, body: "{}" });
  });

  await page.goto("/status/");

  await expect(page.locator("#st-presence")).toHaveText("3");
  await expect(page.locator("#st-cpu-val")).toHaveText("7%");
  await expect(page.locator("#st-mem-val")).toHaveText("312 MiB / 957 MiB");
  await expect(page.locator("#st-lat-val")).toHaveText("44 ms");
  await expect(page.locator("#st-load")).toHaveText("0.12 0.08 0.05");
  await expect(page.locator("#st-uptime")).toHaveText("12 days, 7:57");
  await expect(page.locator("#st-commit")).toHaveText("c584a9e");
  await expect(page.locator("#st-slo")).toHaveText(
    "99.98% available over 90d · p50 42 ms · p99 180 ms",
  );

  const containers = page.locator("#st-containers tr");
  await expect(containers).toHaveCount(2);
  await expect(containers.first()).toContainText("nginx");
  await expect(containers.first()).toContainText("up");

  const upCell = page.locator("#st-containers td.up").first();
  await expect(upCell).toHaveCSS("color", "rgb(63, 185, 80)");

  await expect(page.locator("#st-feed")).toContainText("c584a9e");

  // no SSE traffic events are driven, so the runtime-rendered empty state stays
  const emptyState = page.locator("#st-traffic li.muted");
  await expect(emptyState).toHaveText("no traffic data");
  await expect(emptyState).toHaveCSS("color", "rgb(139, 148, 158)");

  // uptime bars always fill the 90-day window
  await expect(page.locator("#st-bars span")).toHaveCount(90);
  // the CPU sparkline drew a path from the seeded history
  await expect(page.locator("#st-cpu-path")).not.toHaveAttribute("d", "");

  await expect(page.locator("#st-error")).toBeHidden();
  await expect(page.locator("#st-js-note")).toBeHidden();
});

test("falls back to polling when the event stream is over capacity", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/status"))
      return route.fulfill(json(statusFixture()));
    if (url.includes("/api/events")) {
      return route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        body: "over capacity",
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });

  await page.goto("/status/");

  // snapshot still painted from the initial fetch
  await expect(page.locator("#st-presence")).toHaveText("3");
  // the stream is down for good (503, no reconnect) → visible polling note
  await expect(page.locator("#st-polling")).toBeVisible();
  await expect(page.locator("#st-error")).toBeHidden();
});

test("shows the error panel when the initial snapshot fails", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 500, body: "boom" }),
  );

  await page.goto("/status/");

  await expect(page.locator("#st-error")).toBeVisible();
  await expect(page.locator("#st-error")).toContainText("can't reach the API");
  await expect(page.locator("#st-js-note")).toBeHidden();
});

test.describe("no JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("static shell renders with the needs-JS note", async ({ page }) => {
    await page.goto("/status/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "systemctl status",
    );
    await expect(page.getByText(/live data needs JavaScript/)).toBeVisible();
    await expect(page.locator("#st-error")).toBeHidden();
    await expect(page.locator("#st-polling")).toBeHidden();
  });
});
