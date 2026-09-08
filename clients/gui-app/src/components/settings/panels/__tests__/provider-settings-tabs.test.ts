import { describe, expect, it } from "vitest";
import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import {
  PROVIDER_TAB_ORDER,
  providerTabLabel,
  supportedTabsFor,
} from "@/components/settings/panels/provider-settings-tabs";

const ALL_TABS: readonly ProviderSettingsTab[] = [
  "general",
  "env",
  "usage",
  "mcp",
  "plugins",
  "skills",
  "modelProviders",
];

/** What a provider that is not the `opencode` module advertises. */
const WITHOUT_MODEL_PROVIDERS: readonly ProviderSettingsTab[] = ALL_TABS.filter(
  (tab) => tab !== "modelProviders",
);

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
    // `account` is now unconditional (D05: every provider has a Default
    // account row), so it always leads regardless of the advertisement.
    expect(supportedTabsFor({ advertised: ALL_TABS })).toEqual(
      PROVIDER_TAB_ORDER,
    );
  });

  it("honors the host's advertisement rather than showing every tab", () => {
    expect(supportedTabsFor({ advertised: ["env", "mcp"] })).toEqual([
      "account",
      "env",
      "mcp",
    ]);
  });

  it("keeps the CLI tab for every provider that advertises it", () => {
    // This used to be the opposite assertion: cursor and amp were dropped by a
    // `hidesCliCandidates` id check, on the premise that their CLI tab body
    // would render nothing. Both of them spawn the Traycer-resolved binary for
    // their MCP write verbs, so that tab is where a user points Traycer at a
    // binary - the one thing an amp user with nothing on PATH needs and could
    // not reach. The rule is now purely the host's advertisement, with no
    // provider identity in it at all.
    expect(supportedTabsFor({ advertised: ALL_TABS })).toContain("general");
  });

  it("always shows Account, regardless of what the host advertises", () => {
    // D05: every provider exposes a Default account row, so `account` no
    // longer depends on `apiKey.supported` or on any host advertisement.
    expect(
      supportedTabsFor({
        advertised: ["general", "env", "mcp", "plugins", "skills"],
      }),
    ).toContain("account");
    expect(supportedTabsFor({ advertised: [] })).toEqual(["account"]);
  });

  it("shows Account and Usage as SEPARATE tabs when a provider has both", () => {
    // The two answer different questions and one tab could only ever show the
    // half a given provider happened to have.
    const tabs = supportedTabsFor({ advertised: ALL_TABS });
    expect(tabs).toContain("account");
    expect(tabs).toContain("usage");
    expect(tabs.indexOf("account")).toBeLessThan(tabs.indexOf("usage"));
  });

  it("places Account and Usage ahead of CLI & Args", () => {
    // People open Providers to sign in / switch profile / check quota; CLI
    // setup is rarer. The first tab is also the default selection.
    const tabs = supportedTabsFor({ advertised: ALL_TABS });
    expect(tabs[0]).toBe("account");
    expect(tabs[1]).toBe("usage");
    expect(tabs.indexOf("account")).toBeLessThan(tabs.indexOf("general"));
    expect(tabs.indexOf("usage")).toBeLessThan(tabs.indexOf("general"));
  });

  it("opens on Account even when the host advertises nothing else", () => {
    const tabs = supportedTabsFor({ advertised: [] });
    expect(tabs[0]).toBe("account");
  });

  it("falls through to the first supported non-account tab when usage is unadvertised", () => {
    const tabs = supportedTabsFor({ advertised: ["env", "mcp"] });
    expect(tabs[0]).toBe("account");
    expect(tabs[1]).toBe("env");
    expect(tabs).not.toContain("usage");
  });

  it("shows Model Providers only for a host that advertises it", () => {
    // The whole graceful-degrade story for this tab: an old host, an old CLI
    // below the version gate, or any provider that is not the `opencode`
    // module simply leaves the id out, and the tab is then absent - there is no
    // client-side derivation to disagree with that.
    expect(
      supportedTabsFor({ advertised: WITHOUT_MODEL_PROVIDERS }),
    ).not.toContain("modelProviders");
    expect(supportedTabsFor({ advertised: ALL_TABS })).toContain(
      "modelProviders",
    );
  });

  it("keeps Model Providers out of the default-tab position", () => {
    // It sits after env and before the inventory tabs, so adding it cannot
    // change which tab a provider opens on.
    const before = supportedTabsFor({ advertised: WITHOUT_MODEL_PROVIDERS });
    const after = supportedTabsFor({ advertised: ALL_TABS });
    expect(after[0]).toBe(before[0]);
    expect(after.indexOf("modelProviders")).toBeGreaterThan(
      after.indexOf("env"),
    );
    expect(after.indexOf("modelProviders")).toBeLessThan(after.indexOf("mcp"));
  });

  it("leaves every provider with at least one reachable tab", () => {
    // A provider advertising nothing at all: the always-on Account tab is
    // what stops the pane rendering a bare tab rail.
    expect(supportedTabsFor({ advertised: [] })).toEqual(["account"]);
  });

  describe("the tab label lookup", () => {
    // `providerTabLabel` used to special-case `usage` by provider (profiles
    // existed on only three of them); the profile switcher (D25) now owns
    // profile display everywhere, so the lookup is a plain passthrough for
    // every tab, including `usage`.
    const LABELS = {
      general: "CLI & Args",
      account: "Account",
      usage: "Usage",
      env: "Env",
      mcp: "MCP",
      plugins: "Plugins",
      skills: "Skills",
      modelProviders: "Model Providers",
    } as const;

    it("returns the label as given, for every tab", () => {
      for (const tab of Object.keys(LABELS) as (keyof typeof LABELS)[]) {
        expect(providerTabLabel(tab, LABELS)).toBe(LABELS[tab]);
      }
    });
  });
});
