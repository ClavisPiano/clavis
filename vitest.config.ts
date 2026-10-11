import { defineConfig } from "vitest/config";

// Each directory matched here is a Vitest project (root = that directory).
// Add a vitest.config.ts inside a package when it needs its own environment.
export default defineConfig({
  test: {
    projects: ["packages/*", "apps/web", "apps/worker"],
  },
});
