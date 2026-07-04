import { expect, type Page, type Route, test } from "@playwright/test";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

// Routes the homepage's /api traffic: the write-token GET always succeeds, the
// contact POST is fulfilled per-test, and every other island call (status,
// github, events) is quieted so it never reaches the real network.
async function mockContact(
  page: Page,
  post: (route: Route) => Promise<void> | void,
): Promise<void> {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/write-token"))
      return route.fulfill(json({ token: "tok-e2e" }));
    if (url.includes("/api/contact")) return post(route);
    if (url.includes("/api/events")) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: "retry: 100000\n\n",
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
}

test("the form unhides and a successful send swaps in the sent line", async ({
  page,
}) => {
  await mockContact(page, (route) => route.fulfill(json({ sent: true })));

  await page.goto("/");
  await expect(page.locator("#contact-form")).toBeVisible();

  await page.fill("#contact-message", "hello from e2e");
  await page.click("#contact-submit");

  await expect(page.locator("#contact-confirm")).toHaveText(
    "sent. i read these — thanks.",
  );
  await expect(page.locator("#contact-form")).toBeHidden();
});

test("a closed endpoint (503) keeps the closed copy with mailto visible", async ({
  page,
}) => {
  await mockContact(page, (route) =>
    route.fulfill(json({ error: "disabled" }, 503)),
  );

  await page.goto("/");
  await page.fill("#contact-message", "still there?");
  await page.click("#contact-submit");

  await expect(page.locator("#contact-confirm")).toHaveText(
    "messages are closed right now — email works",
  );
  await expect(page.locator("#contact-form")).toBeHidden();
  await expect(
    page.locator("section#contact a[href^='mailto:']"),
  ).toBeVisible();
});

test("a delivery failure keeps the form and mailto usable", async ({
  page,
}) => {
  await mockContact(page, (route) =>
    route.fulfill(json({ error: "delivery_failed" }, 502)),
  );

  await page.goto("/");
  await page.fill("#contact-message", "does this arrive?");
  await page.click("#contact-submit");

  await expect(page.locator("#contact-form-error")).toHaveText(
    "couldn't send — email me instead",
  );
  await expect(page.locator("#contact-form")).toBeVisible();
  await expect(
    page.locator("section#contact a[href^='mailto:']"),
  ).toBeVisible();
});
