import { describe, expect, it } from "vitest";
import {
  isProviderSettingsUnreadableError,
  PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX,
} from "@/lib/providers/provider-settings-unreadable-error";

describe("isProviderSettingsUnreadableError", () => {
  it("is false for a null error", () => {
    expect(isProviderSettingsUnreadableError(null)).toBe(false);
  });

  it("is true for the exact prefix", () => {
    expect(
      isProviderSettingsUnreadableError({
        message: PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX,
      }),
    ).toBe(true);
  });

  it("is true for the prefix followed by a trailing sentence naming the fault", () => {
    expect(
      isProviderSettingsUnreadableError({
        message: `${PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX}: EIO reading config/provider-overrides.json`,
      }),
    ).toBe(true);
  });

  it("is true with leading and trailing whitespace around the message", () => {
    expect(
      isProviderSettingsUnreadableError({
        message: `  ${PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX}  \n`,
      }),
    ).toBe(true);
  });

  it("is false for an unrelated message", () => {
    expect(
      isProviderSettingsUnreadableError({
        message: "spawn failed: ENOENT",
      }),
    ).toBe(false);
  });

  it("is false when the prefix appears only mid-string, not at the start (a prefix test, not a substring test)", () => {
    expect(
      isProviderSettingsUnreadableError({
        message: `Host error: ${PROVIDER_SETTINGS_UNREADABLE_MESSAGE_PREFIX}`,
      }),
    ).toBe(false);
  });
});
