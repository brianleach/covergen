import { defineConfig } from "vitest/config";

// A plain Node library: no DOM environment, which is exactly the shape the
// support matrix records as "component tests cannot run here".
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
