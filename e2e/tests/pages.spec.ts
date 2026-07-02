import { expect, test } from "@playwright/test";

test("layout shell: nav, footer, skip link, meta", async ({ page }) => {
  await page.goto("/");

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "about" })).toHaveAttribute(
    "href",
    "/#about",
  );
  await expect(nav.getByRole("link", { name: "work" })).toHaveAttribute(
    "href",
    "/#work",
  );
  await expect(nav.getByRole("link", { name: "projects" })).toHaveAttribute(
    "href",
    "/#projects",
  );
  await expect(nav.getByRole("link", { name: "resume" })).toHaveAttribute(
    "href",
    "/resume",
  );
  await expect(nav.getByRole("link", { name: "contact" })).toHaveAttribute(
    "href",
    "/#contact",
  );

  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "GitHub" })).toHaveAttribute(
    "href",
    "https://github.com/jimmyMsh",
  );
  await expect(footer.getByRole("link", { name: "LinkedIn" })).toHaveAttribute(
    "href",
    "https://www.linkedin.com/in/jimmymishan/",
  );
  await expect(
    footer.getByRole("link", { name: /jimmymishan2004/ }),
  ).toHaveAttribute("href", "mailto:jimmymishan2004@gmail.com");

  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();

  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /Production Engineer/,
  );
});

test("homepage: hero and all four sections", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Jimmy Mishan",
  );
  await expect(
    page.getByText("Production Engineer at Meta").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /resume/i }).nth(1),
  ).toBeVisible();

  for (const id of ["about", "work", "projects", "contact"]) {
    await expect(page.locator(`section#${id}`)).toBeVisible();
  }

  await expect(page.locator("section#work article")).toHaveCount(4);
  await expect(
    page
      .locator("section#work")
      .getByText("Production Engineer", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("section#work").getByText(/Jun 2024 – Sep 2024/),
  ).toBeVisible();

  await expect(page.locator("section#projects article")).toHaveCount(2);
  await expect(
    page
      .locator("section#projects")
      .getByRole("link", { name: /github/i })
      .first(),
  ).toBeVisible();

  await expect(
    page.locator("section#contact a[href^='mailto:']"),
  ).toBeVisible();
});
