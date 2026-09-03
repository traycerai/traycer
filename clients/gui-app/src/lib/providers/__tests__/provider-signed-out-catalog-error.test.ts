import { describe, expect, it } from "vitest";
import { PROVIDER_DISPLAY_NAMES } from "@traycer/protocol/host/provider-schemas";
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

  // Older hosts pin a protocol from before Reasonix got its own signed-out
  // sentence and still send this generic form for it - the renderer has to
  // keep recognizing it or those hosts fall back to the report-issue row.
  it("is true for the legacy generic 'is signed out. Reconnect to continue.' form for reasonix", () => {
    expect(
      isProviderSignedOutCatalogError("reasonix", {
        message: `${PROVIDER_DISPLAY_NAMES.reasonix} is signed out. Reconnect to continue.`,
      }),
    ).toBe(true);
  });

  it("is false for the legacy generic form built for a DIFFERENT provider", () => {
    expect(
      isProviderSignedOutCatalogError("reasonix", {
        message: `${PROVIDER_DISPLAY_NAMES["claude-code"]} is signed out. Reconnect to continue.`,
      }),
    ).toBe(false);
  });
});
