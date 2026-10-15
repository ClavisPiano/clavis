import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";

/** Short commit and build day. Workers Builds and Actions set the sha; locally git supplies it. */
function buildId(): string {
  let sha = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "";
  if (sha === "") {
    try {
      sha = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      sha = "";
    }
  }
  return `${sha === "" ? "dev" : sha.slice(0, 7)} (${new Date().toISOString().slice(0, 10)})`;
}

// SvelteKit 3 reads its configuration from the plugin options (no svelte.config.js).
export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
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
