import { describe, expect, it } from "vitest";
import {
  EMAIL,
  GITHUB_URL,
  LINKEDIN_URL,
  RESUME_PATH,
  ROLE,
  SITE_DESCRIPTION,
  SITE_TITLE,
} from "./meta";

describe("site metadata", () => {
  it("exposes the site title", () => {
    expect(SITE_TITLE).toBe("Jimmy Mishan");
  });

  it("exposes contact and identity constants", () => {
    expect(ROLE).toBe("Production Engineer at Meta");
    expect(SITE_DESCRIPTION).toContain("Production Engineer");
    expect(EMAIL).toBe("jimmymishan2004@gmail.com");
    expect(GITHUB_URL).toBe("https://github.com/jimmyMsh");
    expect(LINKEDIN_URL).toBe(
      "https://www.linkedin.com/in/jimmy-mishan-1442ba264/",
    );
    expect(RESUME_PATH).toBe("/resume.pdf");
  });
});
