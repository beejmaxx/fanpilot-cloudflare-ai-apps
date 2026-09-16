import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Keep the default local workflow dependency-free. Workers AI has no local
  // emulator, so AI calls fall back to deterministic planning in development.
  // Set CLOUDFLARE_REMOTE_BINDINGS=true to exercise the real AI binding.
  // Deployed builds always use the binding declared in wrangler.jsonc.
  plugins: [
    react(),
    cloudflare({ remoteBindings: process.env.CLOUDFLARE_REMOTE_BINDINGS === "true" }),
  ],
});
