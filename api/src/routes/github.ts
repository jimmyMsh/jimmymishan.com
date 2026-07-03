import { Hono } from "hono";
import type { GithubCache } from "../github.js";

export interface GithubRouteDeps {
  cache: GithubCache;
}

export function githubRoute(deps: GithubRouteDeps): Hono {
  const { cache } = deps;
  const app = new Hono();

  app.get("/api/github", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(cache.current());
  });

  return app;
}
