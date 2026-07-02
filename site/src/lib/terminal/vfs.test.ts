import { describe, expect, it } from "vitest";
import { text } from "./types";
import { createVfs } from "./vfs";

const files = [
  { name: "work.txt", lines: [text("w")] },
  { name: ".plan", hidden: true, lines: [text("p")] },
  { name: "about.txt", lines: [text("a")] },
];

describe("createVfs", () => {
  it("lists visible files alphabetically", () => {
    expect(createVfs(files).list(false)).toEqual(["about.txt", "work.txt"]);
  });

  it("lists dotfiles first with showHidden", () => {
    expect(createVfs(files).list(true)).toEqual([
      ".plan",
      "about.txt",
      "work.txt",
    ]);
  });

  it("gets a file by exact name", () => {
    expect(createVfs(files).get(".plan")?.hidden).toBe(true);
    expect(createVfs(files).get("nope")).toBeUndefined();
  });
});
