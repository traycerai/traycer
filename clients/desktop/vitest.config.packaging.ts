import { defineConfig } from "vitest/config";

// Dedicated config for the real `electron-builder` packaging test - kept
// entirely separate from `vitest.config.ts` (the default `bun run test`
// suite) because that test stamps the real, shared `src/config.ts` to
// `"production"` for the duration of a real pack. See the long comment in
// `scripts/prepack/__integration_tests__/electron-builder-packaging.test.ts`
// for why running it inside the default suite's concurrent worker pool
// raced with unrelated tests that import `../config`. Run via
// `bun run test:packaging`.
export default defineConfig({
  test: {
    include: ["scripts/prepack/__integration_tests__/**/*.test.ts"],
    globals: false,
    fileParallelism: false,
  },
});
