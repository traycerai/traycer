import { describe, expect, it } from "vitest";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_PROVIDER_NATIVE_CAPABILITIES } from "@traycer/protocol/host/provider-native-schemas";
import {
  DEFAULT_PROVIDER_RAIL_VIEW,
  filterProviderRail,
  isProviderRailViewActive,
  PROVIDER_RAIL_STATUS,
  providerRailStatusLabel,
  type ProviderRailView,
} from "@/components/settings/panels/provider-rail-filter";

function state(providerId: ProviderId, enabled: boolean): ProviderCliState {
  return {
    providerId,
    enabled,
    disabledBy: null,
    selected: { kind: "bundled" },
    candidates: [],
    auth: {
      status: "authenticated",
      badgeText: null,
      label: null,
      detail: null,
    },
    authPending: false,
    checkedAt: null,
    apiKey: { supported: false, configured: false, source: null },
    terminalAgentArgs: "",
    envOverrides: [],
    loginCapability: null,
    availabilityPending: false,
    nativeCapabilities: DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
    managedInstallState: null,
    versionVisibility: null,
    advisory: null,
    profiles: [],
  };
}

const PROVIDERS: readonly ProviderCliState[] = [
  state("codex", true),
  state("claude-code", false),
  state("opencode", true),
  state("traycer", false),
  state("kilocode", true),
];

function view(overrides: Partial<ProviderRailView>): ProviderRailView {
  return { ...DEFAULT_PROVIDER_RAIL_VIEW, ...overrides };
}

function idsFor(input: ProviderRailView): readonly ProviderId[] {
  return filterProviderRail(PROVIDERS, input).map(
    (provider) => provider.providerId,
  );
}

describe("filterProviderRail", () => {
  it("returns the SAME array identity when nothing is filtered", () => {
    // Not just an equality check: the panel memoizes on this result, so a fresh
    // array on every render would rebuild every rail row for no reason.
    expect(filterProviderRail(PROVIDERS, DEFAULT_PROVIDER_RAIL_VIEW)).toBe(
      PROVIDERS,
    );
  });

  it("treats a whitespace-only query as no query at all", () => {
    expect(filterProviderRail(PROVIDERS, view({ query: "   " }))).toBe(
      PROVIDERS,
    );
  });

  it("matches the display name case-insensitively", () => {
    expect(idsFor(view({ query: "CLAUDE" }))).toEqual(["claude-code"]);
  });

  it("matches mid-word, not just from the start of the name", () => {
    expect(idsFor(view({ query: "pen" }))).toEqual(["opencode"]);
  });

  it("matches every provider carrying the substring, Codex included", () => {
    // "Codex" contains "code" as surely as "OpenCode" does; a rule that only
    // caught the compound names would be a prefix/word rule pretending to be a
    // substring one.
    expect(idsFor(view({ query: "code" }))).toEqual([
      "codex",
      "claude-code",
      "opencode",
      "kilocode",
    ]);
  });

  it("matches the wire id even where it differs from the display name", () => {
    expect(idsFor(view({ query: "claude-code" }))).toEqual(["claude-code"]);
  });

  it("matches the words the rail RENDERS for Traycer, not the protocol name", () => {
    // `providerDisplayName` overrides this one provider to "Traycer Inference".
    // Searching the protocol's `PROVIDER_DISPLAY_NAMES` instead would leave the
    // second word visible in the rail and unsearchable.
    expect(idsFor(view({ query: "inference" }))).toEqual(["traycer"]);
  });

  it("filters to enabled and to disabled", () => {
    expect(idsFor(view({ status: PROVIDER_RAIL_STATUS.Enabled }))).toEqual([
      "codex",
      "opencode",
      "kilocode",
    ]);
    expect(idsFor(view({ status: PROVIDER_RAIL_STATUS.Disabled }))).toEqual([
      "claude-code",
      "traycer",
    ]);
  });

  it("intersects the query with the status - both must hold", () => {
    expect(
      idsFor(view({ query: "code", status: PROVIDER_RAIL_STATUS.Enabled })),
    ).toEqual(["codex", "opencode", "kilocode"]);
    expect(
      idsFor(view({ query: "code", status: PROVIDER_RAIL_STATUS.Disabled })),
    ).toEqual(["claude-code"]);
  });

  it("returns nothing when the two axes cannot both be satisfied", () => {
    expect(
      idsFor(view({ query: "codex", status: PROVIDER_RAIL_STATUS.Disabled })),
    ).toEqual([]);
  });

  it("preserves the caller's order rather than ranking matches", () => {
    // Alphabetically this would lead with "claude-code"; it leads with "codex"
    // because the input order is kept. The rail re-sorts by provider order
    // anyway, so a relevance rank here would be discarded and would only make
    // the two orders disagree.
    expect(idsFor(view({ query: "cod" }))).toEqual([
      "codex",
      "claude-code",
      "opencode",
      "kilocode",
    ]);
  });
});

describe("isProviderRailViewActive", () => {
  it("is false for the default view and for a blank query", () => {
    expect(isProviderRailViewActive(DEFAULT_PROVIDER_RAIL_VIEW)).toBe(false);
    expect(isProviderRailViewActive(view({ query: "  " }))).toBe(false);
  });

  it("is true for either axis on its own", () => {
    expect(isProviderRailViewActive(view({ query: "co" }))).toBe(true);
    expect(
      isProviderRailViewActive(view({ status: PROVIDER_RAIL_STATUS.Enabled })),
    ).toBe(true);
  });
});

describe("providerRailStatusLabel", () => {
  it("names each status", () => {
    expect(providerRailStatusLabel(PROVIDER_RAIL_STATUS.All)).toBe("All");
    expect(providerRailStatusLabel(PROVIDER_RAIL_STATUS.Enabled)).toBe(
      "Enabled",
    );
    expect(providerRailStatusLabel(PROVIDER_RAIL_STATUS.Disabled)).toBe(
      "Disabled",
    );
  });
});
