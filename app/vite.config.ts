import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      manifest: {
        name: "מערכת סוכנים",
        short_name: "סוכנים",
        lang: "he",
        dir: "rtl",
        start_url: "/",
        display: "standalone",
        background_color: "#F6F6F3",
        theme_color: "#F6F6F3",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  // In development the API runs on the core's port; the built app is served by the core itself.
  server: {
    proxy: Object.fromEntries(["/tasks", "/approvals", "/usage", "/events", "/projects", "/chat", "/push", "/insights", "/settings"].map((p) => [p, "http://127.0.0.1:8787"])),
  },
});
