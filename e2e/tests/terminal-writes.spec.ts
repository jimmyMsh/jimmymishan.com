import { expect, type Page, type Route, test } from "@playwright/test";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const HINT = "# click and type `help` to look around";

// One log event delivered over a mocked SSE stream that then defers its
// reconnect far past the test, so the `log` handler fires exactly once.
const LOG_STREAM =
  'retry: 100000\nevent: log\ndata: {"lines":[{"ts":1751500000,"method":"POST","path":"/streamed-hit","status":201,"country":"CA"}],"dropped":0}\n\n';

async function mockApi(
  page: Page,
  handlers: Partial<
    Record<"guestbook" | "contact" | "logs", (r: Route) => unknown>
  >,
): Promise<void> {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/write-token"))
      return route.fulfill(json({ token: "tok-e2e" }));
    if (url.includes("/api/guestbook") && handlers.guestbook)
      return handlers.guestbook(route);
    if (url.includes("/api/contact") && handlers.contact)
      return handlers.contact(route);
    if (url.includes("/api/logs") && handlers.logs) return handlers.logs(route);
    if (url.includes("/api/events")) {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: LOG_STREAM,
      });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
}

async function openTerminal(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator(".term").click();
  await expect(page.getByText(HINT)).toBeVisible();
}

async function run(page: Page, command: string): Promise<void> {
  await page.getByLabel("terminal input").fill(command);
  await page.getByLabel("terminal input").press("Enter");
}

test("sign posts to the guestbook and confirms with the /guestbook hint", async ({
  page,
}) => {
  await mockApi(page, {
    guestbook: (route) =>
      route.fulfill(
        json(
          { entry: { id: 1, name: "e2e", message: "hello", ts: 1751500000 } },
          201,
        ),
      ),
  });
  await openTerminal(page);
  await run(page, 'sign "hello" --by e2e');

  await expect(page.getByText("signed — thanks, e2e.")).toBeVisible();
  await expect(
    page.locator(".term").getByRole("link", { name: "/guestbook" }),
  ).toHaveAttribute("href", "/guestbook");
});

test("msg delivers a contact message", async ({ page }) => {
  await mockApi(page, {
    contact: (route) => route.fulfill(json({ sent: true })),
  });
  await openTerminal(page);
  await run(page, 'msg "hi there"');

  await expect(page.getByText("sent. i read these — thanks.")).toBeVisible();
});

test("a closed guestbook maps to the dry sign-closed line", async ({
  page,
}) => {
  await mockApi(page, {
    guestbook: (route) => route.fulfill(json({ error: "disabled" }, 503)),
  });
  await openTerminal(page);
  await run(page, 'sign "hello"');

  await expect(
    page.getByText("sign: signing is closed right now"),
  ).toBeVisible();
});

test("tail prints the history, follows the stream, and renders log lines as text", async ({
  page,
}) => {
  await mockApi(page, {
    logs: (route) =>
      route.fulfill(
        json({
          lines: [
            {
              ts: 1751500000,
              method: "GET",
              path: "/history-hit",
              status: 200,
              country: "US",
            },
          ],
        }),
      ),
  });
  await openTerminal(page);
  await run(page, "tail -f access.log");

  // history line from GET /api/logs
  await expect(page.getByText(/200 US GET \/history-hit/)).toBeVisible();
  await expect(
    page.getByText("tail: following access.log — ctrl+c to stop"),
  ).toBeVisible();
  // line pushed over the mocked SSE stream
  await expect(page.getByText(/201 CA POST \/streamed-hit/)).toBeVisible();
});
