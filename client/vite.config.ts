import { defineConfig } from "vite";

export default defineConfig({
  // Expose the dev server on the LAN so teammates can load it during development.
  server: { host: true, port: 5173 },
  build: { outDir: "dist", target: "es2022" },
});
