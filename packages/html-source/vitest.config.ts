import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: false,
    include: ["src/__tests__/**/*.test.ts"],
    globals: false,
  },
});
