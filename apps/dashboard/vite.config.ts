import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: {
    host: "127.0.0.1",
    headers: { "Cache-Control": "no-store" },
    allowedHosts: process.env.EPHOR_DEV_ORIGIN
      ? [new URL(process.env.EPHOR_DEV_ORIGIN).hostname]
      : [],
    hmr: process.env.EPHOR_DEV_ORIGIN
      ? {
          protocol: "wss",
          host: new URL(process.env.EPHOR_DEV_ORIGIN).hostname,
          clientPort: 443,
        }
      : undefined,
    proxy: {
      "/daemon": {
        target: process.env.EPHOR_API_URL ?? "http://127.0.0.1:3002",
      },
      "/api": { target: process.env.EPHOR_API_URL ?? "http://127.0.0.1:3002" },
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      spa: { enabled: true, prerender: { outputPath: "/index.html" } },
    }),
    react(),
  ],
});
