import type { Vfs, VfsFile } from "./types";

export function createVfs(files: VfsFile[]): Vfs {
  const byName = new Map(files.map((f) => [f.name, f]));
  return {
    list(showHidden) {
      return files
        .filter((f) => showHidden || !f.hidden)
        .map((f) => f.name)
        .sort((a, b) => {
          const dotA = a.startsWith(".");
          const dotB = b.startsWith(".");
          if (dotA !== dotB) return dotA ? -1 : 1;
          return a.localeCompare(b);
        });
    },
    get(name) {
      return byName.get(name);
    },
  };
}
