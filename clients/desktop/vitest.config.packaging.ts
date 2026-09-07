import { defineConfig } from "vitest/config";
import { ZOD_INLINE_SERVER_DEPS } from "./vitest.shared";

export default defineConfig({
  test: {
    server: ZOD_INLINE_SERVER_DEPS,
    include: ["scripts/prepack/__integration_tests__/**/*.test.ts"],
    globals: false,
    fileParallelism: false,
  },
});
