import { resolve as resolveTestSetup } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    sequence: { setupFiles: "list" },
    setupFiles: [
      resolveTestSetup(
        import.meta.dirname,
        "../../scripts/test-worker-environment.ts",
      ),
    ],
    clearMocks: false,
    include: ["src/__tests__/**/*.test.ts"],
    globals: false,
  },
});
