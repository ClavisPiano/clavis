import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// SvelteKit 3 reads its configuration from the plugin options (no svelte.config.js).
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: false }),
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
