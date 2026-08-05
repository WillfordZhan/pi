import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/ai/management/console/",
  build: {
    outDir: path.resolve(__dirname, "../static/manage-console"),
    emptyOutDir: true,
  },
});
