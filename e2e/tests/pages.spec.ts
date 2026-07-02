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
