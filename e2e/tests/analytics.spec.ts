import { expect, test } from "@playwright/test";

const COUNT_SRC = "https://stats.jimmymishan.com/count.js";
const COUNT_ENDPOINT = "https://stats.jimmymishan.com/count";

test("the GoatCounter count.js tag is wired into the shared head", async ({
  page,
}) => {
  for (const path of ["/", "/guestbook/"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const tag = page.locator("head script[data-goatcounter]");
    await expect(tag).toHaveAttribute("src", COUNT_SRC);
    await expect(tag).toHaveAttribute("data-goatcounter", COUNT_ENDPOINT);
    await expect(tag).toHaveAttribute("async", "");
  }
});

// count.js ignores localhost and private networks by default (only sending
// pageviews when allow_local is set — which we deliberately never set), so an
// e2e run against the local preview server must never emit a pageview beacon.
// The only request permitted to reach the analytics host is the count.js asset
// itself; anything else (a /count beacon) would pollute real analytics.
test("no analytics pageview beacon leaves the local preview", async ({
  page,
}) => {
  const statsRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().includes("stats.jimmymishan.com"))
      statsRequests.push(req.url());
  });

  for (const path of ["/", "/status/", "/guestbook/", "/resume/"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    // give any (mis)fired beacon a beat to appear before asserting its absence
    await page.waitForTimeout(300);
  }

  const beacons = statsRequests.filter((u) => !/\/count\.js(\?|$)/.test(u));
  expect(beacons).toEqual([]);
});
