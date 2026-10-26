import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served by the pair server in production. `npm run dev:web` proxies
// API/WebSocket traffic to a server already running on PAIR_PORT (default 7420).
const port = process.env.PAIR_PORT ?? "7420";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    proxy: {
      "/api": `http://localhost:${port}`,
      "/ws": { target: `ws://localhost:${port}`, ws: true },
    },
  },
});
