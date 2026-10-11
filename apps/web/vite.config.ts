import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// SvelteKit 3 reads its configuration from the plugin options (no svelte.config.js).
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ pages: "build", assets: "build", fallback: "index.html", strict: false }),
      // The SPA fallback serves every route, so relative asset paths would break on nested routes
      // such as /dev/notation (it would ask for /dev/_app/... and /dev/service-worker.js).
      paths: { relative: false },
      // The static build has an inline bootstrap script, so script-src uses hashes that SvelteKit
      // writes into a <meta> CSP tag. Directives a meta tag cannot carry (frame-ancestors) live in
      // static/_headers. Keep both in sync with docs/deploy.md.
      csp: {
        mode: "hash",
        directives: {
          "default-src": ["self"],
          "script-src": ["self", "wasm-unsafe-eval"],
          "style-src": ["self", "unsafe-inline"],
          "img-src": ["self", "data:", "blob:"],
          "media-src": ["self", "blob:"],
          "font-src": ["self"],
          "connect-src": ["self"],
          "worker-src": ["self", "blob:"],
          "manifest-src": ["self"],
          "base-uri": ["self"],
          "object-src": ["none"],
        },
      },
    }),
  ],
  // Module workers (notation, T3.2) need ES output: the default iife format cannot hold the Verovio
  // module, which uses import.meta.url and top-level await.
  worker: { format: "es" },
  // Component tests (Svelte + happy-dom, chosen per file with `// @vitest-environment happy-dom`)
  // need Svelte's client build, not the server one.
  resolve: process.env.VITEST ? { conditions: ["browser"] } : {},
  test: {
    include: ["src/**/*.test.ts"],
  },
});
