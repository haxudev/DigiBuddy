import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const staticRoot = resolve(process.cwd(), "dist");
const app = createApp({ staticRoot });

serve({
  fetch: app.fetch,
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || "0.0.0.0",
});
