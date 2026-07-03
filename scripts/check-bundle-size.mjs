#!/usr/bin/env node
// Gzip-size budget gate for the client islands. Astro emits one entry chunk per
// island script named "<Source>.astro_astro_type_script_index_<n>_lang.<hash>.js";
// the "<Source>...index_<n>" part is stable across builds, only "<hash>" rotates.
// Each island's real download cost is its entry chunk plus the transitive closure
// of chunks it statically imports (the shared client/format chunks), each gzipped
// as the browser fetches them — one resource at a time.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const KB = 1024;
const ASTRO_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "site",
  "dist",
  "_astro",
);

const ISLANDS = [
  {
    name: "terminal",
    prefix: "Terminal.astro_astro_type_script_index_0_lang",
    budget: 10 * KB,
  },
  {
    name: "status",
    prefix: "StatusDashboard.astro_astro_type_script_index_0_lang",
    budget: 8 * KB,
  },
  {
    name: "projects cards",
    prefix: "index.astro_astro_type_script_index_0_lang",
    budget: 3 * KB,
  },
];

// Static and side-effect imports of sibling chunks; excludes lazy import(...)
// since those are not fetched to run the island.
const IMPORT_RE = /(?:from|import)\s*["'](\.\/[^"']+\.js)["']/g;

function findEntry(prefix) {
  const matches = readdirSync(ASTRO_DIR).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".js"),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one entry chunk for "${prefix}", found ${matches.length}: ${matches.join(", ") || "none"}`,
    );
  }
  return matches[0];
}

function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(join(ASTRO_DIR, file), "utf8");
    IMPORT_RE.lastIndex = 0;
    let m = IMPORT_RE.exec(src);
    while (m !== null) {
      const dep = m[1].replace(/^\.\//, "");
      if (!seen.has(dep)) stack.push(dep);
      m = IMPORT_RE.exec(src);
    }
  }
  return [...seen];
}

function gzipBytes(file) {
  return gzipSync(readFileSync(join(ASTRO_DIR, file)), { level: 9 }).length;
}

const fmtKb = (n) => `${(n / KB).toFixed(2)} KB`;

let failed = false;
for (const island of ISLANDS) {
  const entry = findEntry(island.prefix);
  const chunks = closure(entry);
  const total = chunks.reduce((sum, c) => sum + gzipBytes(c), 0);
  const ok = total <= island.budget;
  if (!ok) failed = true;
  console.log(
    `${ok ? "ok  " : "OVER"}  ${island.name.padEnd(14)} ${fmtKb(total).padStart(9)} / ${fmtKb(island.budget)} gzipped`,
  );
  console.log(`        chunks: ${chunks.join(", ")}`);
}

if (failed) {
  console.error("\nbundle-size gate failed: an island exceeds its gzip budget");
  process.exit(1);
}
console.log("\nall islands within budget");
