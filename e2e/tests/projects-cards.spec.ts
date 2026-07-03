import { expect, test } from "@playwright/test";

// One repo present (jimmymishan.com), so the other project card has no match
// and must stay exactly as the build rendered it.
function githubFixture() {
  const pushedAt = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
  return {
    fetched_at: Math.floor(Date.now() / 1000),
    repos: [
      {
        name: "jimmymishan.com",
        description: "this site",
        stars: 42,
        language: "TypeScript",
        pushed_at: pushedAt,
        url: "https://github.com/jimmyMsh/jimmymishan.com",
        fork: false,
      },
    ],
  };
}

const matched = 'article[data-github-repo="jimmymishan.com"]';
const unmatched = 'article[data-github-repo="PE-portfolio"]';

test("decorates the matching card and leaves the unmatched one alone", async ({
  page,
}) => {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/github"))
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(githubFixture()),
      });
    return route.fulfill({ status: 404, body: "{}" });
  });

  await page.goto("/");

  await expect(page.locator(`${matched} .project-github-meta`)).toHaveText(
    "★ 42 · TypeScript · pushed 2d ago",
  );
  await expect(page.locator(`${unmatched} .project-github-meta`)).toHaveCount(
    0,
  );
});

test("leaves every card untouched when the API fails", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/api/github"))
      return route.fulfill({ status: 500, body: "boom" });
    return route.fulfill({ status: 404, body: "{}" });
  });

  // wait for the (failed) fetch to complete before asserting nothing changed
  const githubDone = page.waitForResponse("**/api/github");
  await page.goto("/");
  await githubDone;

  await expect(page.locator(".project-github-meta")).toHaveCount(0);
  // the build-time links are still there
  await expect(
    page.locator(`${matched}`).getByRole("link", { name: "GitHub" }),
  ).toBeVisible();
});
