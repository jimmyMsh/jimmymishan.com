import { expect, type Page, test } from "@playwright/test";

const HINT = "# click and type `help` to look around";
const TAGLINE =
  "production engineer @ meta — I keep systems fast, boring, and online.";

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
    history: [{ ts: nowSec - 2, cpu_pct: 7.1, mem_used_mb: 312 }],
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
      days: [],
      recent: [],
    },
    commit: "c584a9e",
    api_uptime_s: 4242,
  };
}

// Route every /api call: status resolves (or fails) per the test, github is an
// empty cache so the projects island stays quiet, everything else 404s.
async function mockApi(page: Page, status: "ok" | "fail"): Promise<void> {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/status")) {
      return status === "ok"
        ? route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(statusFixture()),
          })
        : route.fulfill({ status: 500, body: "boom" });
    }
    if (url.includes("/api/github"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ fetched_at: null, repos: [] }),
      });
    return route.fulfill({ status: 404, body: "{}" });
  });
}

async function openTerminal(page: Page): Promise<void> {
  await page.locator(".term").click();
  await expect(page.getByText(HINT)).toBeVisible();
}

async function run(page: Page, command: string): Promise<void> {
  await page.getByLabel("terminal input").fill(command);
  await page.getByLabel("terminal input").press("Enter");
}

test("status prints the live snapshot", async ({ page }) => {
  await mockApi(page, "ok");
  await page.goto("/");
  await openTerminal(page);
  await run(page, "status");

  await expect(
    page.getByText(
      /host: cpu 7\.1% · mem 312\/957 MiB · load 0\.12 0\.08 0\.05/,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /containers: nginx up \(0\.1% · 12 MiB\) · api up \(2\.3% · 40 MiB\)/,
    ),
  ).toBeVisible();
  await expect(page.getByText("presence: 3 here now")).toBeVisible();
  await expect(
    page.getByText(
      /uptime \(90d window\): 99\.98% avail · p50 42ms · p99 180ms/,
    ),
  ).toBeVisible();
  await expect(
    page.locator(".term").getByRole("link", { name: "/status" }),
  ).toHaveAttribute("href", "/status");
});

test("docker prints the curated container table", async ({ page }) => {
  await mockApi(page, "ok");
  await page.goto("/");
  await openTerminal(page);
  await run(page, "docker");

  await expect(page.getByText(/NAME\s+STATUS\s+CPU\s+MEM/)).toBeVisible();
  await expect(page.getByText(/nginx\s+up\s+0\.1%\s+12 MiB/)).toBeVisible();
  await expect(page.getByText(/api\s+up\s+2\.3%\s+40 MiB/)).toBeVisible();
});

test("a live command prints the flavored error when the API is unreachable", async ({
  page,
}) => {
  await mockApi(page, "fail");
  await page.goto("/");
  await openTerminal(page);
  await run(page, "status");

  await expect(
    page.getByText(
      "status: can't reach the api — try the dashboard at /status",
    ),
  ).toBeVisible();
});

test("autoplay shows the live step when the snapshot arrives in time", async ({
  page,
}) => {
  await mockApi(page, "ok");
  await page.goto("/");

  await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });
  await expect(
    page.getByText(/# live: up .+ · 3 people here now/),
  ).toBeVisible();
});

test("autoplay omits the live step when the snapshot is unavailable", async ({
  page,
}) => {
  await mockApi(page, "fail");
  await page.goto("/");

  await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(TAGLINE)).toBeVisible();
  await expect(page.getByText(/# live:/)).toHaveCount(0);
});
