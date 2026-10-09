import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5 flipped clearMocks to true; keep the v4 behavior (mock call history persists across tests).
    clearMocks: false,
    include: ["scripts/__tests__/**/*.test.{ts,mjs,js}"],
    environment: "node",
  },
});
