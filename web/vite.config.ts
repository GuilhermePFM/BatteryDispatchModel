import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The repo root: methodology reads docs/model/model.md and the form reads the
// JSON Schemas under contracts/, so both stay the single source.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Vendor code in its own long-cached chunks; the app chunk stays small.
        codeSplitting: {
          groups: [
            { name: "echarts", test: /node_modules[\\/](echarts|zrender|tslib)[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|scheduler|cookie|set-cookie-parser)[\\/]/ },
            { name: "auth", test: /node_modules[\\/](oidc-client-ts|jwt-decode)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
