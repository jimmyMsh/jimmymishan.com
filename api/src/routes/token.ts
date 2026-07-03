import { Hono } from "hono";
import { mintToken } from "../writes/gate.js";

export interface TokenRouteDeps {
  secret: string;
  nowSec?: () => number;
}

export function tokenRoute(deps: TokenRouteDeps): Hono {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  app.get("/api/write-token", (c) => {
    return c.json({ token: mintToken(deps.secret, nowSec()) });
  });

  return app;
}
