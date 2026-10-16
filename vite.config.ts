import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare({ viteEnvironment: { name: "worker" } })],
  environments: {
    worker: { build: { sourcemap: true } },
  },
});
