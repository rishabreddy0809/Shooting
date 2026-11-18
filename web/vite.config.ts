import { defineConfig } from "vite";

// Relative base so the built folder can be served from any path (or opened from a static host).
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
