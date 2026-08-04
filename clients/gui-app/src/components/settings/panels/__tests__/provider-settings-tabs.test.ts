import { describe, expect, it } from "vitest";
import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import {
  PROVIDER_TAB_ORDER,
  supportedTabsFor,
} from "@/components/settings/panels/provider-settings-tabs";

const ALL_TABS: readonly ProviderSettingsTab[] = [
  "general",
  "env",
  "usage",
  "mcp",
  "plugins",
  "skills",
];

/**
 * Deliberately a PURE test, not a render of `ProvidersSettingsPanel`.
 *
 * The render-level versions of these cases lived in
 * `providers-settings-panel.test.tsx` and destabilised 39 of that file's
 * profile/sign-in tests - but only when the file ran inside the full
 * `src/components/` sweep under CPU load, never in isolation, and regardless of
 * where in the file they sat. That file is ~5.7k lines and already sensitive to
 * dialog-mount timing; two more full panel mounts were enough to tip it. The
 * rules under test are pure, so they do not need a DOM to be pinned down.
 */
describe("supportedTabsFor", () => {
  it("keeps a normal provider's advertised tabs in display order", () => {
    // `account` is absent because it is never advertised - it is derived from
    // `apiKeySupported` alone, which is false here.
    expect(
      supportedTabsFor({
        providerId: "codex",
        apiKeySupported: false,
        advertised: ALL_TABS,
      }),
    ).toEqual(PROVIDER_TAB_ORDER.filter((tab) => tab !== "account"));
  });

  it("honors the host's advertisement rather than showing every tab", () => {
    expect(
      supportedTabsFor({
        providerId: "codex",
        apiKeySupported: false,
        advertised: ["env", "mcp"],
      }),
    ).toEqual(["env", "mcp"]);
  });

  it.each(["cursor", "amp"] as const)(
    "drops the CLI tab for %s, whose body would render nothing",
    (providerId) => {
      // The host DOES advertise `general` here - the point is that the client
      // refuses to list a tab it knows is empty.
      const tabs = supportedTabsFor({
        providerId,
        apiKeySupported: false,
        advertised: ALL_TABS,
      });
      expect(tabs).not.toContain("general");
      expect(tabs).toContain("env");
    },
  );

  it("shows Account for an API-key provider even when nothing account-ish was advertised", () => {
    // amp is exactly this: it takes a key but advertises no `usage` tab,
    // because it has no managed profiles and no rate limits to report. The key
    // field is the only way to authenticate it, so its tab cannot depend on
    // that advertisement.
    const tabs = supportedTabsFor({
      providerId: "amp",
      apiKeySupported: true,
      advertised: ["general", "env", "mcp", "plugins", "skills"],
    });
    expect(tabs).toContain("account");
    expect(tabs).not.toContain("usage");
  });

  it("does not show Account for a provider without an API key", () => {
    expect(
      supportedTabsFor({
        providerId: "codex",
        apiKeySupported: false,
        advertised: ["env", "mcp", "usage"],
      }),
    ).not.toContain("account");
  });

  it("shows Account and Profiles & Limits as SEPARATE tabs when a provider has both", () => {
    // The two answer different questions and one tab could only ever show the
    // half a given provider happened to have.
    const tabs = supportedTabsFor({
      providerId: "droid",
      apiKeySupported: true,
      advertised: ALL_TABS,
    });
    expect(tabs).toContain("account");
    expect(tabs).toContain("usage");
    expect(tabs.indexOf("account")).toBeLessThan(tabs.indexOf("usage"));
  });

  it("leaves an API-key provider with at least one reachable tab", () => {
    // cursor loses `general` and is advertised nothing else: the derived
    // Account tab is what stops the pane rendering a bare tab rail.
    expect(
      supportedTabsFor({
        providerId: "cursor",
        apiKeySupported: true,
        advertised: ["general"],
      }),
    ).toEqual(["account"]);
  });
});
