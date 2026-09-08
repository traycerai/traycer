import { describe, expect, it } from "vitest";

import { providerSignedOutMessage } from "../provider-display";
import { providerIdSchema } from "../provider-ids";
import { PROVIDER_DISPLAY_NAMES } from "../provider-schemas";

const PROVIDER_IDS = providerIdSchema.options;

describe("providerSignedOutMessage", () => {
  it("names the real fix for Reasonix, which has no account to reconnect", () => {
    // Reasonix reads provider keys from its own `<home>/.env` only; the
    // generic "reconnect" sentence sent users to export a shell variable the
    // CLI never reads. The renderer matches this string EXACTLY to recognise
    // the signed-out catalog verdict, so the wording is a contract.
    expect(providerSignedOutMessage("reasonix")).toBe(
      "Reasonix has no usable API key configured. Run reasonix setup to continue.",
    );
  });

  it("keeps the generic reconnect sentence, built from the display name, for every other provider", () => {
    for (const providerId of PROVIDER_IDS) {
      if (providerId === "reasonix") continue;
      expect(providerSignedOutMessage(providerId)).toBe(
        `${PROVIDER_DISPLAY_NAMES[providerId]} is signed out. Reconnect to continue.`,
      );
    }
  });

  it("shows Antigravity's real name in its generic reconnect sentence", () => {
    // The loop above only proves the sentence is built from whatever
    // `PROVIDER_DISPLAY_NAMES.antigravity` happens to hold - it would pass
    // even if that entry were a typo. Pin the literal copy separately.
    expect(PROVIDER_DISPLAY_NAMES.antigravity).toBe("Antigravity");
    expect(providerSignedOutMessage("antigravity")).toBe(
      "Antigravity is signed out. Reconnect to continue.",
    );
  });
});
