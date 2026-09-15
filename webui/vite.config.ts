import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "browser-server-boundary",
      enforce: "pre",
      load(id) {
        if (id.includes("/src/server/") || id.includes("/node_modules/@azure/")) {
          throw new Error("Server-only code cannot be imported by the SPA.");
        }
      },
    },
    react(),
  ],
  // Runtime configuration and credentials belong exclusively to the BFF.
  envPrefix: [],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/.auth": "http://127.0.0.1:3000",
    },
  },
});
