import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  envDir: "../..",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true
  },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "AgentHub",
        short_name: "AgentHub",
        start_url: "/",
        display: "standalone",
        background_color: "#f3f4f6",
        theme_color: "#0f172a",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "96x96",
            type: "image/svg+xml",
            purpose: "any"
          }
        ]
      }
    })
  ]
});
