import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({ remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === "true" }),
  ],
});
