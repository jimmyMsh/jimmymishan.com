import { expect, type Route, test } from "@playwright/test";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

// A message crafted to break out of a text node if the island ever set
// innerHTML instead of createTextNode. It must survive as literal text.
const HOSTILE = '<img src=x onerror="window.__xss=1">';

function feed(nowSec: number) {
  return {
    token: "tok-e2e",
    entries: [
      { id: 2, name: "ada", message: HOSTILE, ts: nowSec - 60 },
      { id: 1, name: "grace", message: "first!", ts: nowSec - 3600 },
    ],
  };
}

test("renders the mocked feed and keeps hostile strings as literal text", async ({
  page,
}) => {
  const nowSec = Math.floor(Date.now() / 1000);
  await page.route("**/api/guestbook", (route: Route) => {
    if (route.request().method() === "GET")
      return route.fulfill(json(feed(nowSec)));
    return route.fulfill(json({ error: "invalid" }, 400));
  });

  await page.goto("/guestbook/");

  const items = page.locator("#gb-list li");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("ada");
  await expect(items.nth(1)).toContainText("grace");
  await expect(items.nth(1)).toContainText("first!");

  // The hostile string is present verbatim as text, never parsed as markup.
  await expect(items.nth(0).locator(".gb-msg")).toHaveText(HOSTILE);
  await expect(page.locator("#gb-list img, #gb-list script")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();

  await expect(page.locator("#gb-error")).toBeHidden();
});

test("signing prepends the new entry and confirms", async ({ page }) => {
  const nowSec = Math.floor(Date.now() / 1000);
  await page.route("**/api/guestbook", (route: Route) => {
    if (route.request().method() === "GET")
      return route.fulfill(json(feed(nowSec)));
    return route.fulfill(
      json(
        {
          entry: {
            id: 3,
            name: "e2e",
            message: "hi from the test",
            ts: nowSec,
          },
        },
        201,
      ),
    );
  });

  await page.goto("/guestbook/");
  await page.fill("#gb-name", "e2e");
  await page.fill("#gb-message", "hi from the test");
  await page.click("#gb-submit");

  await expect(page.locator("#gb-confirm")).toHaveText("signed — thanks, e2e.");
  const first = page.locator("#gb-list li").first();
  await expect(first).toContainText("e2e");
  await expect(first).toContainText("hi from the test");
  await expect(page.locator("#gb-list li")).toHaveCount(3);
});

test("a closed guestbook (503) hides the form and shows the closed line", async ({
  page,
}) => {
  const nowSec = Math.floor(Date.now() / 1000);
  await page.route("**/api/guestbook", (route: Route) => {
    if (route.request().method() === "GET")
      return route.fulfill(json(feed(nowSec)));
    return route.fulfill(json({ error: "disabled" }, 503));
  });

  await page.goto("/guestbook/");
  await page.fill("#gb-message", "anyone home?");
  await page.click("#gb-submit");

  await expect(page.locator("#gb-form-error")).toHaveText(
    "signing is closed right now",
  );
  await expect(page.locator("#gb-form")).toBeHidden();
});

test("a load failure shows the error line", async ({ page }) => {
  await page.route("**/api/guestbook", (route: Route) =>
    route.fulfill({ status: 500, body: "boom" }),
  );

  await page.goto("/guestbook/");
  await expect(page.locator("#gb-error")).toBeVisible();
  await expect(page.locator("#gb-error")).toHaveText(
    "guestbook can't load right now",
  );
});
