import { describe, expect, it } from "vitest";
import { providerSignedOutMessage } from "@traycer/protocol/host/provider-display";
import { isProviderSignedOutCatalogError } from "@/lib/providers/provider-signed-out-catalog-error";

describe("isProviderSignedOutCatalogError", () => {
  it("is true for the exact signed-out message, including surrounding whitespace", () => {
    const message = `  ${providerSignedOutMessage("reasonix")}  \n`;
    expect(isProviderSignedOutCatalogError("reasonix", { message })).toBe(true);
  });

  it("is false for a different message", () => {
    expect(
      isProviderSignedOutCatalogError("reasonix", {
        message: "spawn failed: ENOENT",
      }),
    ).toBe(false);
  });

  it("is false for a null error", () => {
    expect(isProviderSignedOutCatalogError("reasonix", null)).toBe(false);
  });

  it("is false when the message is the signed-out verdict for a DIFFERENT provider", () => {
    expect(
      isProviderSignedOutCatalogError("reasonix", {
        message: providerSignedOutMessage("claude-code"),
      }),
    ).toBe(false);
  });
});
