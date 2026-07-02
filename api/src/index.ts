import { serve } from "@hono/node-server";
import { app } from "./app.js";

const server = serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`api listening on :${info.port}`);
});

const shutdown = () => {
  server.close((err) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
