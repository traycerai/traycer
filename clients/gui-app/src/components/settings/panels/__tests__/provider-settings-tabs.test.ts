import { describe, expect, it } from "vitest";
import type { ProviderSettingsTab } from "@traycer/protocol/host/provider-native-schemas";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
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
    // `account` is absent because it is never advertised - it is derived from
    // `apiKeySupported` alone, which is false here.
    expect(
      supportedTabsFor({
        apiKeySupported: false,
        advertised: ALL_TABS,
      }),
    ).toEqual(PROVIDER_TAB_ORDER.filter((tab) => tab !== "account"));
  });

  it("honors the host's advertisement rather than showing every tab", () => {
    expect(
      supportedTabsFor({
        apiKeySupported: false,
        advertised: ["env", "mcp"],
      }),
    ).toEqual(["env", "mcp"]);
  });

  it("keeps the CLI tab for every provider that advertises it", () => {
    // This used to be the opposite assertion: cursor and amp were dropped by a
    // `hidesCliCandidates` id check, on the premise that their CLI tab body
    // would render nothing. Both of them spawn the Traycer-resolved binary for
    // their MCP write verbs, so that tab is where a user points Traycer at a
    // binary - the one thing an amp user with nothing on PATH needs and could
    // not reach. The rule is now purely the host's advertisement, with no
    // provider identity in it at all.
    expect(
      supportedTabsFor({
        apiKeySupported: true,
        advertised: ALL_TABS,
      }),
    ).toContain("general");
  });

  it("shows Account for an API-key provider even when nothing account-ish was advertised", () => {
    // amp is exactly this: it takes a key but advertises no `usage` tab,
    // because it has no managed profiles and no rate limits to report. The key
    // field is the only way to authenticate it, so its tab cannot depend on
    // that advertisement.
    const tabs = supportedTabsFor({
      apiKeySupported: true,
      advertised: ["general", "env", "mcp", "plugins", "skills"],
    });
    expect(tabs).toContain("account");
    expect(tabs).not.toContain("usage");
  });

  it("does not show Account for a provider without an API key", () => {
    expect(
      supportedTabsFor({
        apiKeySupported: false,
        advertised: ["env", "mcp", "usage"],
      }),
    ).not.toContain("account");
  });

  it("shows Account and Profiles & Limits as SEPARATE tabs when a provider has both", () => {
    // The two answer different questions and one tab could only ever show the
    // half a given provider happened to have.
    const tabs = supportedTabsFor({
      apiKeySupported: true,
      advertised: ALL_TABS,
    });
    expect(tabs).toContain("account");
    expect(tabs).toContain("usage");
    expect(tabs.indexOf("account")).toBeLessThan(tabs.indexOf("usage"));
  });

  it("places Account and Profiles & Limits ahead of CLI & Args", () => {
    // People open Providers to sign in / switch profile / check quota; CLI
    // setup is rarer. The first supported tab is also the default selection.
    const tabs = supportedTabsFor({
      apiKeySupported: true,
      advertised: ALL_TABS,
    });
    expect(tabs[0]).toBe("account");
    expect(tabs[1]).toBe("usage");
    expect(tabs.indexOf("account")).toBeLessThan(tabs.indexOf("general"));
    expect(tabs.indexOf("usage")).toBeLessThan(tabs.indexOf("general"));
  });

  it("opens on Profiles & Limits when Account is unsupported", () => {
    const tabs = supportedTabsFor({
      apiKeySupported: false,
      advertised: ALL_TABS,
    });
    expect(tabs[0]).toBe("usage");
    expect(tabs).not.toContain("account");
  });

  it("falls through to the first supported non-account tab when neither account nor usage apply", () => {
    const tabs = supportedTabsFor({
      apiKeySupported: false,
      advertised: ["env", "mcp"],
    });
    expect(tabs[0]).toBe("env");
    expect(tabs).not.toContain("account");
    expect(tabs).not.toContain("usage");
  });

  it("shows Model Providers only for a host that advertises it", () => {
    // The whole graceful-degrade story for this tab: an old host, an old CLI
    // below the version gate, or any provider that is not the `opencode`
    // module simply leaves the id out, and the tab is then absent - there is no
    // client-side derivation to disagree with that.
    expect(
      supportedTabsFor({
        apiKeySupported: false,
        advertised: WITHOUT_MODEL_PROVIDERS,
      }),
    ).not.toContain("modelProviders");
    expect(
      supportedTabsFor({ apiKeySupported: false, advertised: ALL_TABS }),
    ).toContain("modelProviders");
  });

  it("keeps Model Providers out of the default-tab position", () => {
    // It sits after env and before the inventory tabs, so adding it cannot
    // change which tab a provider opens on.
    const before = supportedTabsFor({
      apiKeySupported: false,
      advertised: WITHOUT_MODEL_PROVIDERS,
    });
    const after = supportedTabsFor({
      apiKeySupported: false,
      advertised: ALL_TABS,
    });
    expect(after[0]).toBe(before[0]);
    expect(after.indexOf("modelProviders")).toBeGreaterThan(
      after.indexOf("env"),
    );
    expect(after.indexOf("modelProviders")).toBeLessThan(after.indexOf("mcp"));
  });

  it("leaves an API-key provider with at least one reachable tab", () => {
    // A provider advertising nothing at all: the derived Account tab is what
    // stops the pane rendering a bare tab rail.
    expect(
      supportedTabsFor({
        apiKeySupported: true,
        advertised: [],
      }),
    ).toEqual(["account"]);
  });

  describe("the usage tab's label", () => {
    // The tab holds managed profiles AND usage limits, but profiles exist for
    // Claude Code, Codex, and Grok - so a fixed "Profiles & Limits" promised a
    // section that is not there on the other providers.
    const LABELS = {
      general: "CLI & Args",
      account: "Account",
      usage: "Profiles & Limits",
      env: "Env",
      mcp: "MCP",
      plugins: "Plugins",
      skills: "Skills",
      modelProviders: "Model Providers",
    } as const;

    it("promises profiles only where profiles exist", () => {
      for (const providerId of ["claude-code", "codex", "grok"] as const) {
        expect(providerTabLabel("usage", LABELS, providerId)).toBe(
          "Profiles & Limits",
        );
      }
    });

    it("names what the tab actually holds everywhere else", () => {
      // The panel's own words: the section inside is headed "Usage limits".
      // Every provider id except the profile-backed ones, so a newly added
      // provider cannot regress to the profiles label without failing here.
      const everywhereElse = providerIdSchema.options.filter(
        (id) => id !== "claude-code" && id !== "codex" && id !== "grok",
      );
      for (const providerId of everywhereElse) {
        expect(providerTabLabel("usage", LABELS, providerId)).toBe(
          "Usage limits",
        );
      }
    });

    it("leaves every other tab's label alone", () => {
      // Only `usage` varies, and the tab ID never does - it is the wire enum.
      for (const tab of ["general", "env", "mcp", "skills"] as const) {
        expect(providerTabLabel(tab, LABELS, "grok")).toBe(LABELS[tab]);
        expect(providerTabLabel(tab, LABELS, "claude-code")).toBe(LABELS[tab]);
      }
    });
  });
});
