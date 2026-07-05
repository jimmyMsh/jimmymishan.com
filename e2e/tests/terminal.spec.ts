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

test("tail without its file argument prints usage", async ({ page }) => {
  await openTerminal(page);
  await run(page, "tail");
  await expect(page.getByText("usage: tail -f access.log")).toBeVisible();
});

test("Tab completes commands and cat/open arguments", async ({ page }) => {
  await openTerminal(page);
  const input = page.getByLabel("terminal input");

  await input.fill("up");
  await input.press("Tab");
  await expect(input).toHaveValue("uptime ");

  await input.fill("cat ab");
  await input.press("Tab");
  await expect(input).toHaveValue("cat about.txt ");

  await input.fill("open re");
  await input.press("Tab");
  await expect(input).toHaveValue("open resume ");
});

test("Ctrl+C aborts sl mid-animation and the prompt stays alive", async ({
  page,
}) => {
  await openTerminal(page);
  await run(page, "sl");
  // the locomotive is on screen (distinctive glyphs survive every frame)
  await expect(page.getByText(/\[\]\[\]/).first()).toBeVisible();

  await page.getByLabel("terminal input").press("Control+c");
  await expect(page.getByText("^C")).toBeVisible();

  await run(page, "whoami");
  await expect(page.getByText(TAGLINE).last()).toBeVisible();
});

test("Ctrl+L clears the screen and the prompt keeps working", async ({
  page,
}) => {
  await openTerminal(page);
  await expect(page.getByText(HINT)).toBeVisible();

  await page.getByLabel("terminal input").press("Control+l");
  await expect(page.getByText(HINT)).toHaveCount(0);

  await run(page, "pwd");
  await expect(page.getByText("/home/jimmy")).toBeVisible();
});

test("focused command input shows an unclipped inset focus ring", async ({
  page,
}) => {
  await page.goto("/");
  await openTerminal(page);
  const input = page.locator(".term-input");
  await input.focus();
  await expect(input).toHaveCSS("outline-style", "none");
  const boxShadow = await input.evaluate(
    (el) => getComputedStyle(el).boxShadow,
  );
  expect(boxShadow).toContain("inset");
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
