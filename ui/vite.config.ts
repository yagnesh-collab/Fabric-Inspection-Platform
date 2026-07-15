import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/consumer": {
        target: "http://consumer:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/consumer/, ""),
      },
      "/api/jetson": {
        target: "http://jetson-sim:8001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/jetson/, ""),
      },
    },
  },
});
