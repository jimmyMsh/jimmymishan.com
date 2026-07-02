import { describe, expect, it } from "vitest";
import { buildFiles } from "./content";

const meta = {
  email: "j@example.com",
  githubUrl: "https://github.com/jimmyMsh",
  linkedinUrl: "https://www.linkedin.com/in/jimmymishan/",
};

const work = [
  {
    role: "Production Engineer",
    company: "Meta",
    start: "2025-01",
    end: null,
    summary: "keeps things online",
    highlights: ["did a thing", "did another"],
  },
];

const projects = [
  {
    name: "jimmymishan.com",
    summary: "this site",
    repo: "https://github.com/jimmyMsh/jimmymishan.com",
  },
];

function flat(file: { lines: { segments: { text: string }[] }[] }): string {
  return file.lines
    .map((l) => l.segments.map((s) => s.text).join(""))
    .join("\n");
}

describe("buildFiles", () => {
  const files = buildFiles(work, projects, meta);
  const byName = new Map(files.map((f) => [f.name, f]));

  it("builds exactly the six expected virtual files", () => {
    expect([...byName.keys()].sort()).toEqual([
      ".plan",
      "about.txt",
      "contact.txt",
      "projects.txt",
      "resume.pdf",
      "work.txt",
    ]);
  });

  it("renders work entries with role, range, summary, bullets", () => {
    const out = flat(byName.get("work.txt")!);
    expect(out).toContain("Production Engineer @ Meta");
    expect(out).toContain("Jan 2025 – Present");
    expect(out).toContain("keeps things online");
    expect(out).toContain("- did a thing");
  });

  it("renders project repo links as link segments", () => {
    const projectsFile = byName.get("projects.txt")!;
    const seg = projectsFile.lines
      .flatMap((l) => l.segments)
      .find((s) => "href" in s && s.href);
    expect(seg?.href).toBe("https://github.com/jimmyMsh/jimmymishan.com");
    expect(seg?.text).toBe("github.com/jimmyMsh/jimmymishan.com");
  });

  it("renders contact links (mailto + socials)", () => {
    const segs = byName.get("contact.txt")!.lines.flatMap((l) => l.segments);
    expect(segs.some((s) => s.href === "mailto:j@example.com")).toBe(true);
    expect(segs.some((s) => s.href === meta.githubUrl)).toBe(true);
    expect(segs.some((s) => s.href === meta.linkedinUrl)).toBe(true);
  });

  it("marks resume.pdf binary with the /resume navigation", () => {
    expect(byName.get("resume.pdf")!.binary).toEqual({
      message: "resume.pdf is a binary file — opening /resume …",
      navigateTo: "/resume",
    });
  });

  it("hides .plan", () => {
    expect(byName.get(".plan")!.hidden).toBe(true);
  });
});
