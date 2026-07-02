import { expect, type Page, test } from "@playwright/test";

const HINT = "# click and type `help` to look around";
const TAGLINE =
  "production engineer @ meta — I keep systems fast, boring, and online.";

async function openTerminal(page: Page): Promise<void> {
  await page.goto("/");
  // pointerdown skips autoplay and focuses the input
  await page.locator(".term").click();
  await expect(page.getByText(HINT)).toBeVisible();
}

async function run(page: Page, command: string): Promise<void> {
  await page.getByLabel("terminal input").fill(command);
  await page.getByLabel("terminal input").press("Enter");
}

test("autoplay reaches the finished transcript", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(TAGLINE)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(HINT)).toBeVisible({ timeout: 10_000 });
});

test("click skips autoplay and focuses the input", async ({ page }) => {
  await openTerminal(page);
  await expect(page.getByLabel("terminal input")).toBeFocused();
});

test("help lists commands and the not-everything hint", async ({ page }) => {
  await openTerminal(page);
  await run(page, "help");
  await expect(page.getByText(/whoami\s+one line about me/)).toBeVisible();
  await expect(page.getByText("# not everything is listed.")).toBeVisible();
});

test("ls and cat read the virtual files", async ({ page }) => {
  await openTerminal(page);
  await run(page, "ls");
  await expect(page.getByText(/about\.txt {2}contact\.txt/)).toBeVisible();
  await run(page, "cat contact.txt");
  await expect(
    page.locator(".term").getByRole("link", { name: "github.com/jimmyMsh" }),
  ).toBeVisible();
});

test("cat resume.pdf navigates to /resume", async ({ page }) => {
  await openTerminal(page);
  await run(page, "cat resume.pdf");
  await page.waitForURL("**/resume");
});

test("unknown command errors dryly", async ({ page }) => {
  await openTerminal(page);
  await run(page, "wat");
  await expect(
    page.getByText("command not found: wat — try `help`"),
  ).toBeVisible();
});

test("arrow-up recalls history", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo hi there");
  await page.getByLabel("terminal input").press("ArrowUp");
  await expect(page.getByLabel("terminal input")).toHaveValue("echo hi there");
});

test("future commands answer with the honest teaser", async ({ page }) => {
  await openTerminal(page);
  await run(page, "uptime");
  await expect(page.getByText(/uptime: not wired up yet/)).toBeVisible();
});

test.describe("reduced motion", () => {
  test("renders the finished state without typing", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // full autoplay takes ~2.5s; reduced motion must be immediate
    await expect(page.getByText(HINT)).toBeVisible({ timeout: 800 });
  });
});

test.describe("mobile viewport", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("terminal is usable", async ({ page }) => {
    await openTerminal(page);
    await run(page, "whoami");
    await expect(page.getByText(TAGLINE).last()).toBeVisible();
  });
});

test.describe("no JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("static fallback renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(TAGLINE)).toBeVisible();
    await expect(
      page.getByText(/this terminal needs JavaScript/),
    ).toBeVisible();
  });
});
