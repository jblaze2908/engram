import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built into app/dist/web, which the server serves at /. `npm run dev:web` proxies the API to a server on :8340.
const api = { target: "http://127.0.0.1:8340", changeOrigin: false };
export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: { proxy: { "/api": api, "/mcp": api } },
});
