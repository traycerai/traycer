import { describe, expect, it } from "vitest";
import {
  GUI_HARNESS_BY_PROVIDER_ID,
  providerIdFromHarnessOrProviderName,
} from "../provider-harness-ids";

describe("providerIdFromHarnessOrProviderName", () => {
  it("resolves the harness id of the one provider whose ids differ", () => {
    expect(providerIdFromHarnessOrProviderName("claude")).toBe("claude-code");
  });

  it("resolves the provider id itself", () => {
    expect(providerIdFromHarnessOrProviderName("claude-code")).toBe(
      "claude-code",
    );
  });

  it("resolves a name that is both a harness id and a provider id", () => {
    expect(providerIdFromHarnessOrProviderName("codex")).toBe("codex");
  });

  it("round-trips every provider through its harness id and its own id", () => {
    for (const [providerId, harnessId] of Object.entries(
      GUI_HARNESS_BY_PROVIDER_ID,
    )) {
      expect(providerIdFromHarnessOrProviderName(harnessId)).toBe(providerId);
      expect(providerIdFromHarnessOrProviderName(providerId)).toBe(providerId);
    }
  });

  it("returns null for a name that is neither", () => {
    expect(providerIdFromHarnessOrProviderName("not-a-provider")).toBeNull();
  });

  it("returns null for the empty string", () => {
    expect(providerIdFromHarnessOrProviderName("")).toBeNull();
  });

  it("does not match names inherited from Object.prototype", () => {
    expect(providerIdFromHarnessOrProviderName("toString")).toBeNull();
    expect(providerIdFromHarnessOrProviderName("__proto__")).toBeNull();
    expect(providerIdFromHarnessOrProviderName("constructor")).toBeNull();
  });

  it("is case and whitespace sensitive", () => {
    expect(providerIdFromHarnessOrProviderName("Claude")).toBeNull();
    expect(providerIdFromHarnessOrProviderName(" claude")).toBeNull();
  });
});
