import { describe, expect, it } from "vitest";
import { shippedConfig } from "../scripts/shipped-config";

describe("shipped mobile pool endpoint", () => {
  it("ships staging with the pool endpoint and production without one", () => {
    expect(shippedConfig("staging", "").poolBaseUrl).toBe(
      "wss://pool.sandbox.dev.traycer.ai/v1/session",
    );
    expect(shippedConfig("production", "").poolBaseUrl).toBe("");
  });
});
