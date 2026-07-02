import { describe, expect, it } from "vitest";
import { parse } from "./parser";

describe("parse", () => {
  it("returns empty cmd for blank input", () => {
    expect(parse("")).toEqual({ cmd: "", args: [] });
    expect(parse("   ")).toEqual({ cmd: "", args: [] });
  });

  it("splits command and args on whitespace", () => {
    expect(parse("cat about.txt")).toEqual({
      cmd: "cat",
      args: ["about.txt"],
    });
    expect(parse("  ls   -a ")).toEqual({ cmd: "ls", args: ["-a"] });
  });

  it('groups double-quoted strings (the sign "msg" seam)', () => {
    expect(parse('sign "hello world"')).toEqual({
      cmd: "sign",
      args: ["hello world"],
    });
  });

  it("groups single-quoted strings", () => {
    expect(parse("echo 'a b' c")).toEqual({ cmd: "echo", args: ["a b", "c"] });
  });

  it("joins quoted spans inside a token", () => {
    expect(parse('echo a"b c"d')).toEqual({ cmd: "echo", args: ["ab cd"] });
  });

  it("treats an unterminated quote as running to end of input", () => {
    expect(parse('echo "unterminated span')).toEqual({
      cmd: "echo",
      args: ["unterminated span"],
    });
  });

  it("lowercases nothing and preserves arg case", () => {
    expect(parse("Echo Hi")).toEqual({ cmd: "Echo", args: ["Hi"] });
  });
});
