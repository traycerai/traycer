import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  agentGuiListHarnessesDowngradeV7ToV1,
  agentGuiListHarnessesDowngradeV7ToV2,
  agentGuiListHarnessesDowngradeV7ToV3,
  agentGuiListHarnessesDowngradeV7ToV4,
  agentGuiListHarnessesDowngradeV7ToV5,
  agentGuiListHarnessesDowngradeV7ToV6,
  agentGuiListHarnessesUpgradeV70ToV71,
} from "@traycer/protocol/host/agent/gui/contracts";
import {
  guiHarnessOptionSchema,
  guiHarnessOptionSchemaV21,
  guiHarnessOptionSchemaV30,
  guiHarnessOptionSchemaV40,
  guiHarnessOptionSchemaV50,
  guiHarnessOptionSchemaV60,
  listGuiHarnessesResponseSchemaV10,
  listGuiHarnessesResponseSchemaV20,
  listGuiHarnessesResponseSchemaV21,
  listGuiHarnessesResponseSchemaV30,
  listGuiHarnessesResponseSchemaV40,
  listGuiHarnessesResponseSchemaV50,
  listGuiHarnessesResponseSchemaV60,
  listGuiHarnessesResponseSchemaV70,
  guiHarnessOptionSchemaV71,
  listGuiHarnessesResponseSchemaV71,
  type GuiHarnessOption,
} from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  providersListDowngradeV7ToV1,
  providersListDowngradeV7ToV2,
  providersListDowngradeV7ToV3,
  providersListDowngradeV7ToV4,
  providersListDowngradeV7ToV5,
  providersListDowngradeV7ToV6,
  providersListUpgradeV70ToV71,
  providersSetEnabledDowngradeV22ToV10,
  providersSetEnabledUpgradeV21ToV22,
} from "@traycer/protocol/host/registry";
import {
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV30,
  providersListResponseSchemaV40,
  providersListResponseSchemaV50,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
  providersListResponseSchemaV71,
  providersSetEnabledRequestSchemaV10,
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledRequestSchemaV22,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV10,
  type ProviderEnablementMode,
  type ProviderEnablementSource,
} from "@traycer/protocol/host/provider-schemas";

/**
 * Auth-aware enablement (Plan 3): `agent.gui.listHarnesses@7.1`,
 * `providers.list@7.1`, `providers.setEnabled@2.2`. Every one of these lines
 * is additive-only and fills nothing on upgrade - absence of `authStatus` /
 * `enablementMode` / `enablementSource` / `mode` is itself the "this host
 * predates auto enablement" signal the client keys its fallback on, so a
 * fill anywhere in this chain is a real regression, not a convenience.
 */

// Derived from the schemas rather than hand-written unions: a hand-written one
// silently narrows (the first pass omitted `unavailable`, so no test ever
// exercised it) and a future enum member would go untested by omission.
interface HarnessOptionOverrides {
  readonly authStatus?: GuiHarnessOption["authStatus"];
  readonly enablementMode?: GuiHarnessOption["enablementMode"];
}

// Built through the FROZEN 7.1 row rather than the live one: 7.1 is pinned to
// the v7.0 id set (a released 7.0 forbids any minor of major 7 from growing the
// enum), so the live row is strictly wider than anything this line serializes.
// Parsing through the live shape here would let a post-7.0 id reach a v7 bridge
// in a test and nowhere else.
function harnessOption(id: string, overrides: HarnessOptionOverrides) {
  return guiHarnessOptionSchemaV71.parse({
    id,
    label: id,
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    ...overrides,
  });
}

interface ProviderStateOverrides {
  readonly enablementMode?: ProviderEnablementMode;
  readonly enablementSource?: ProviderEnablementSource;
}

function providerState(providerId: string, overrides: ProviderStateOverrides) {
  return {
    providerId,
    enabled: true,
    disabledBy: null,
    selected: { kind: "bundled" as const },
    candidates: [],
    auth: {
      status: "unknown" as const,
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
    nativeCapabilities: {
      supportedTabs: ["general", "env", "usage"] as const,
      mcp: null,
      plugins: null,
      skills: null,
    },
    ...overrides,
  };
}

// ── 1. agent.gui.listHarnesses@7.1 ──────────────────────────────────────────

describe("agent.gui.listHarnesses@7.1 (auth-aware enablement row fields)", () => {
  it("the 7.0 -> 7.1 upgrade fills NOTHING - both fields stay absent", () => {
    const v70Response = listGuiHarnessesResponseSchemaV70.parse({
      harnesses: [harnessOption("claude", {})],
    });
    expect(v70Response.harnesses[0]).not.toHaveProperty("authStatus");
    expect(v70Response.harnesses[0]).not.toHaveProperty("enablementMode");

    const upgraded =
      agentGuiListHarnessesUpgradeV70ToV71.upgradeResponse(v70Response);
    expect(upgraded.harnesses[0]).not.toHaveProperty("authStatus");
    expect(upgraded.harnesses[0]).not.toHaveProperty("enablementMode");
    // Absence must be distinguishable from every concrete value - a v7.0
    // host is exactly the host the client's providers.list fallback exists
    // for, and a fill here would fabricate a verdict the client then trusts
    // over that fallback.
    expect(listGuiHarnessesResponseSchemaV70.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it.each([
    [
      "v6.0",
      agentGuiListHarnessesDowngradeV7ToV6,
      listGuiHarnessesResponseSchemaV60,
      guiHarnessOptionSchemaV60,
    ],
    [
      "v5.0",
      agentGuiListHarnessesDowngradeV7ToV5,
      listGuiHarnessesResponseSchemaV50,
      guiHarnessOptionSchemaV50,
    ],
    [
      "v4.0",
      agentGuiListHarnessesDowngradeV7ToV4,
      listGuiHarnessesResponseSchemaV40,
      guiHarnessOptionSchemaV40,
    ],
    [
      "v3.0",
      agentGuiListHarnessesDowngradeV7ToV3,
      listGuiHarnessesResponseSchemaV30,
      guiHarnessOptionSchemaV30,
    ],
    [
      "v2.1",
      agentGuiListHarnessesDowngradeV7ToV2,
      listGuiHarnessesResponseSchemaV21,
      guiHarnessOptionSchemaV21,
    ],
  ] as const)(
    "the 7.1 -> %s downgrade strips authStatus/enablementMode while preserving decodable rows",
    (_label, downgrade, responseSchema, rowSchema) => {
      const v71Response = guiHarnessOptionSchemaV71.array().parse([
        harnessOption("claude", {
          authStatus: "unauthenticated",
          enablementMode: "auto",
        }),
      ]);
      const result = downgrade.downgradeResponse({
        harnesses: v71Response,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.harnesses[0]).not.toHaveProperty("authStatus");
      expect(result.value.harnesses[0]).not.toHaveProperty("enablementMode");
      expect(() => responseSchema.parse(result.value)).not.toThrow();
      expect(() => rowSchema.parse(result.value.harnesses[0])).not.toThrow();
    },
  );

  it("the 7.1 -> v1.0 downgrade strips both fields and every post-v1.0 harness", () => {
    const result = agentGuiListHarnessesDowngradeV7ToV1.downgradeResponse(
      listGuiHarnessesResponseSchemaV71.parse({
        harnesses: [
          harnessOption("claude", {
            authStatus: "unauthenticated",
            enablementMode: "off",
          }),
          harnessOption("grok", {}),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harnesses.map((h) => h.id)).toEqual(["claude"]);
    expect(result.value.harnesses[0]).not.toHaveProperty("authStatus");
    expect(result.value.harnesses[0]).not.toHaveProperty("enablementMode");
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("guiHarnessOptionSchemaV21/V30/V40/V50/V60 do not model authStatus/enablementMode at all - the freeze bug this line fixes", () => {
    // Assert directly against the frozen row shapes' key sets, not merely
    // through a downgrade-bridge fixture: before the freeze these were
    // `guiHarnessOptionSchema.extend({ id })`, i.e. a pinned id over the LIVE
    // body, so a field added to the live row would have silently widened all
    // six shipped lines at once.
    for (const schema of [
      guiHarnessOptionSchemaV21,
      guiHarnessOptionSchemaV30,
      guiHarnessOptionSchemaV40,
      guiHarnessOptionSchemaV50,
      guiHarnessOptionSchemaV60,
    ]) {
      expect(schema.shape).not.toHaveProperty("authStatus");
      expect(schema.shape).not.toHaveProperty("enablementMode");
    }
    // Only the LIVE row (bound by v7.1, the head) carries them.
    expect(guiHarnessOptionSchema.shape).toHaveProperty("authStatus");
    expect(guiHarnessOptionSchema.shape).toHaveProperty("enablementMode");
  });

  it("the v7.0 row is frozen too - it does not model the two new fields either", () => {
    const parsed = listGuiHarnessesResponseSchemaV70.parse({
      harnesses: [
        {
          id: "claude",
          label: "claude",
          available: true,
          error: null,
          modes: ["gui" as const],
          requiresApiKey: false,
          // A v7.0 wire payload would never carry these; a real host never
          // sends them on this line, but a strict-schema parse must still
          // strip them if they somehow arrived, exactly like every other
          // frozen line does.
          authStatus: "unauthenticated",
          enablementMode: "off",
        },
      ],
    });
    expect(parsed.harnesses[0]).not.toHaveProperty("authStatus");
    expect(parsed.harnesses[0]).not.toHaveProperty("enablementMode");
  });
});

// ── 2. providers.list@7.1 ───────────────────────────────────────────────────

describe("providers.list@7.1 (auth-aware enablement provider fields)", () => {
  it("the 7.0 -> 7.1 upgrade fills NOTHING for enablementMode/enablementSource", () => {
    const v70Response = providersListResponseSchemaV70.parse({
      providers: [providerState("claude-code", {})],
      native: null,
    });
    expect(v70Response.providers[0]).not.toHaveProperty("enablementMode");
    expect(v70Response.providers[0]).not.toHaveProperty("enablementSource");

    const upgraded = providersListUpgradeV70ToV71.upgradeResponse(v70Response);
    expect(upgraded.providers[0]).not.toHaveProperty("enablementMode");
    expect(upgraded.providers[0]).not.toHaveProperty("enablementSource");
    expect(providersListResponseSchemaV70.safeParse(upgraded).success).toBe(
      true,
    );
  });

  it("enabled stays a required strict boolean on 7.1 and carries the effective value untouched", () => {
    const parsed = providersListResponseSchema.parse({
      providers: [
        providerState("claude-code", {
          enablementMode: "auto",
          enablementSource: "auto-detected",
        }),
      ],
      native: null,
    });
    expect(parsed.providers[0].enabled).toBe(true);
    expect(typeof parsed.providers[0].enabled).toBe("boolean");
    // enablementMode/Source never replace it.
    expect(parsed.providers[0].enablementMode).toBe("auto");
    expect(parsed.providers[0].enablementSource).toBe("auto-detected");
  });

  it.each([
    ["v6.0", providersListDowngradeV7ToV6, providersListResponseSchemaV60],
    ["v5.0", providersListDowngradeV7ToV5, providersListResponseSchemaV50],
    ["v4.0", providersListDowngradeV7ToV4, providersListResponseSchemaV40],
    ["v3.0", providersListDowngradeV7ToV3, providersListResponseSchemaV30],
    ["v2.0", providersListDowngradeV7ToV2, providersListResponseSchemaV20],
  ] as const)(
    "the 7.1 -> %s downgrade strips enablementMode/enablementSource while preserving decodable rows",
    (_label, downgrade, responseSchema) => {
      // Parsed through the FROZEN 7.1 response, not the live one: 7.1 is
      // pinned to the v7.0 provider id set, so the live shape is strictly
      // wider than anything this line serializes.
      const v71Response = providersListResponseSchemaV71.parse({
        providers: [
          providerState("claude-code", {
            enablementMode: "on",
            enablementSource: "sticky",
          }),
        ],
        native: null,
      });
      const result = downgrade.downgradeResponse(v71Response);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.providers[0]).not.toHaveProperty("enablementMode");
      expect(result.value.providers[0]).not.toHaveProperty("enablementSource");
      expect(result.value.providers[0].enabled).toBe(true);
      expect(() => responseSchema.parse(result.value)).not.toThrow();
    },
  );

  // REGRESSION PIN for a defect this suite caught and that is now fixed.
  //
  // `downgradeProviderCliStateToV10` (provider-schemas.ts) destructures every
  // post-v1.0 field off the row before the STRICT `providerCliStateSchemaV10`
  // parse, and its own comment warns that every field added to the live shape
  // "must be added to this destructure too... forgetting one does not fail
  // loudly - it empties the provider list for v1.0 clients, silently". The
  // v7.1 pair was duly forgotten on the first pass: a provider carrying either
  // field did not lose the two fields, the WHOLE ROW vanished from the
  // v1.0-downgraded `providers.list` response.
  //
  // So this asserts stripped-NOT-vanished, which is the distinction the defect
  // turned on and the one a future field will get wrong the same way. The
  // companion test below covers a row with no enablement fields at all, so a
  // failure here localizes to these two rather than to v1.0 downgrading
  // generally.
  it("the 7.1 -> v1.0 downgrade strips both fields and PRESERVES the row", () => {
    const result = providersListDowngradeV7ToV1.downgradeResponse(
      providersListResponseSchemaV71.parse({
        providers: [
          providerState("claude-code", {
            enablementMode: "off",
            enablementSource: "sticky",
          }),
          providerState("grok", {}),
        ],
        native: null,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
    ]);
    expect(result.value.providers[0]).not.toHaveProperty("enablementMode");
    expect(result.value.providers[0]).not.toHaveProperty("enablementSource");
    expect(() =>
      providersListResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("the 7.1 -> v1.0 downgrade PRESERVES a row carrying no enablement fields, dropping only the post-v1.0 provider (unaffected baseline)", () => {
    const result = providersListDowngradeV7ToV1.downgradeResponse(
      providersListResponseSchemaV71.parse({
        providers: [
          providerState("claude-code", {}),
          providerState("grok", {}),
        ],
        native: null,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
    ]);
    expect(() =>
      providersListResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });
});

// ── 3. providers.setEnabled@2.2 ─────────────────────────────────────────────

describe("providers.setEnabled@2.2 (tri-state mode)", () => {
  it("the 2.1 -> 2.2 upgrade is identity - mode is absent for a 2.1 caller", () => {
    const v21Request = providersSetEnabledRequestSchemaV21.parse({
      providerId: "claude-code",
      enabled: true,
      profileAction: null,
    });
    expect(v21Request).not.toHaveProperty("mode");

    const upgraded =
      providersSetEnabledUpgradeV21ToV22.upgradeRequest(v21Request);
    expect(upgraded).not.toHaveProperty("mode");
    expect(upgraded.enabled).toBe(true);
    expect(
      providersSetEnabledRequestSchemaV22.safeParse(upgraded).success,
    ).toBe(true);
  });

  it("the registered 2.2 -> v1.0 downgrade drops BOTH profileAction and mode - v1.0's strict request would otherwise reject the whole call", () => {
    const v22Request = providersSetEnabledRequestSchemaV22.parse({
      providerId: "claude-code",
      enabled: false,
      profileAction: null,
      mode: "off",
    });
    // A leaked key fails v1.0's strict parse outright.
    expect(
      providersSetEnabledRequestSchemaV10.safeParse(v22Request).success,
    ).toBe(false);

    const downgraded =
      providersSetEnabledDowngradeV22ToV10.downgradeRequest(v22Request);
    expect(downgraded).toMatchObject({
      ok: true,
      value: { providerId: "claude-code", enabled: false },
    });
    if (!downgraded.ok) return;
    expect(downgraded.value).not.toHaveProperty("profileAction");
    expect(downgraded.value).not.toHaveProperty("mode");
    expect(() =>
      providersSetEnabledRequestSchemaV10.parse(downgraded.value),
    ).not.toThrow();
  });

  it("the 2.2 -> v1.0 downgrade response echo still strips to the frozen v1.0 state shape", () => {
    const state = providersListResponseSchema.parse({
      providers: [providerState("claude-code", {})],
      native: null,
    }).providers[0];
    const downgraded = providersSetEnabledDowngradeV22ToV10.downgradeResponse(
      providersSetEnabledResponseSchema.parse({ state }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(() =>
      providersSetEnabledResponseSchemaV10.parse(downgraded.value),
    ).not.toThrow();
  });
});

// ── 4. Registry loads with the expected latestMinor per line ───────────────

describe("hostRpcRegistry loads with the auth-aware enablement lines at their expected latestMinor", () => {
  // Module-load validation already enforces "a downgrade must start at the
  // line's latest minor" - importing the registry at all would throw if that
  // were violated. This makes the expectation a legible, named assertion
  // rather than relying on the import succeeding silently.
  it("agent.gui.listHarnesses major 7 -> latestMinor 1", () => {
    expect(hostRpcRegistry["agent.gui.listHarnesses"][7].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["agent.gui.listHarnesses"][7].versions[1],
    ).toBeDefined();
  });

  it("providers.list major 7 -> latestMinor 1", () => {
    expect(hostRpcRegistry["providers.list"][7].latestMinor).toBe(1);
    expect(hostRpcRegistry["providers.list"][7].versions[1]).toBeDefined();
  });

  it("providers.setEnabled major 2 -> latestMinor 2", () => {
    expect(hostRpcRegistry["providers.setEnabled"][2].latestMinor).toBe(2);
    expect(
      hostRpcRegistry["providers.setEnabled"][2].versions[2],
    ).toBeDefined();
    // The downgrade-from-latest table re-points at the new bridge.
    expect(
      hostRpcRegistry["providers.setEnabled"][2].downgradePathsFromLatest[1],
    ).toBe(providersSetEnabledDowngradeV22ToV10);
  });
});

// ── 5. Forward tolerance: an unknown enum member degrades one field ─────────
//
// The four response-side enablement fields are `.optional().catch(undefined)`.
// `.optional()` alone is not enough: nothing on the path to the array element
// catches, so a value a NEWER host minted - a `enablementSource` arm added in
// some future 7.2, say - would fail the whole response and empty the client's
// provider list / harness picker over one field it could have ignored.
//
// Negotiation is meant to make that unreachable, since a newer host downgrades
// to the negotiated minor. These tests are the defense-in-depth behind that
// assumption, which this very line has already broken twice (released rows
// pinned over a live body; `downgradeProviderCliStateToV10` dropping whole
// rows). Degrading to `undefined` is the supported old-host path.
describe("forward tolerance for unknown enum members", () => {
  it("listHarnesses: an unknown authStatus/enablementMode drops those fields, not the row", () => {
    const parsed = guiHarnessOptionSchema.parse({
      id: "claude",
      label: "claude",
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
      authStatus: "some-future-status",
      enablementMode: "some-future-mode",
    });
    // The row survives with its other fields intact...
    expect(parsed.id).toBe("claude");
    expect(parsed.available).toBe(true);
    // ...and the two unreadable fields read exactly like an old host's absence,
    // which is the fallback the client already implements.
    expect(parsed.authStatus).toBeUndefined();
    expect(parsed.enablementMode).toBeUndefined();
  });

  it("providers.list: an unknown enablementMode/enablementSource drops those fields, not the provider", () => {
    const response = providersListResponseSchema.parse({
      providers: [
        providerState("claude-code", {}),
        {
          ...providerState("codex", {}),
          enablementMode: "some-future-mode",
          enablementSource: "some-future-source",
        },
      ],
      native: null,
    });
    // Critically: BOTH providers survive. Without the catch the unknown member
    // fails the array element and takes the entire response with it.
    expect(response.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(response.providers[1]?.enablementMode).toBeUndefined();
    expect(response.providers[1]?.enablementSource).toBeUndefined();
    // `enabled` is untouched - it is a plain boolean and always readable, so
    // the client still gets the effective verdict even when the explanation
    // for it is from a vocabulary this build does not have.
    expect(response.providers[1]?.enabled).toBe(true);
  });

  it("setEnabled REQUEST rejects an unknown mode rather than swallowing it", () => {
    // Deliberately asymmetric with the response fields above. A response that
    // degrades costs a read-only explanation; a REQUEST that degrades would
    // silently rewrite the user's intent, because an absent `mode` falls back
    // to the legacy `enabled` boolean - "Auto" would be recorded as sticky.
    expect(
      providersSetEnabledRequestSchemaV22.safeParse({
        providerId: "codex",
        enabled: true,
        profileAction: null,
        mode: "some-future-mode",
      }).success,
    ).toBe(false);
  });
});
