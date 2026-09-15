import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadLocalEnvironment } from "./environment.ts";

loadLocalEnvironment();
const staticRoot = fileURLToPath(new URL("../../dist/", import.meta.url));
const app = createApp({ staticRoot });

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || "127.0.0.1",
});
