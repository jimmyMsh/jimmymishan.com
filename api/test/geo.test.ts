import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// mmdb-lib is mocked so geo.ts's Reader-wrapping logic can be exercised without
// shipping a binary fixture: the state below drives the fake Reader per test.
const reader = vi.hoisted(() => ({
  get: vi.fn<(ip: string) => unknown>(),
  throwOnConstruct: false,
}));

vi.mock("mmdb-lib", () => ({
  Reader: class {
    constructor(_db: Buffer) {
      if (reader.throwOnConstruct) throw new Error("corrupt database");
    }
    get(ip: string): unknown {
      return reader.get(ip);
    }
  },
}));

import { loadGeo } from "../src/logs/geo.js";

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "geo-test-"));
  dbPath = join(dir, "country.mmdb");
  writeFileSync(dbPath, Buffer.from("not a real mmdb but readable"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  reader.get.mockReset();
  reader.throwOnConstruct = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadGeo", () => {
  it("returns a constant '--' lookup and logs one note when the file is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const geo = loadGeo(join(dir, "does-not-exist.mmdb"));

    expect(geo.country("8.8.8.8")).toBe("--");
    expect(geo.country("1.1.1.1")).toBe("--");
    // The mmdb Reader is never constructed when the file cannot be read.
    expect(reader.get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns a constant '--' lookup and logs one note when the file is corrupt", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reader.throwOnConstruct = true;

    const geo = loadGeo(dbPath);

    expect(geo.country("8.8.8.8")).toBe("--");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves a known IP to its ISO alpha-2 country code", () => {
    reader.get.mockImplementation((ip) =>
      ip === "8.8.8.8" ? { country: { iso_code: "US" } } : null,
    );

    const geo = loadGeo(dbPath);

    expect(geo.country("8.8.8.8")).toBe("US");
    expect(reader.get).toHaveBeenCalledWith("8.8.8.8");
  });

  it("returns '--' when the database has no record for the IP", () => {
    reader.get.mockReturnValue(null);

    const geo = loadGeo(dbPath);

    expect(geo.country("203.0.113.5")).toBe("--");
  });

  it("returns '--' when the record has no country field", () => {
    reader.get.mockReturnValue({ continent: { code: "EU" } });

    const geo = loadGeo(dbPath);

    expect(geo.country("203.0.113.5")).toBe("--");
  });

  it("returns '--' when a lookup throws", () => {
    reader.get.mockImplementation(() => {
      throw new Error("bad address");
    });

    const geo = loadGeo(dbPath);

    expect(geo.country("not-an-ip")).toBe("--");
  });

  it("logs no note on a successful load", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reader.get.mockReturnValue({ country: { iso_code: "DE" } });

    const geo = loadGeo(dbPath);
    geo.country("8.8.8.8");

    expect(warn).not.toHaveBeenCalled();
  });
});
