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
  guiHarnessOptionSchemaV70,
  listGuiHarnessesResponseSchemaV10,
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
  providersListDowngradeV7ToV6,
  providersSetEnabledDowngradeV21ToV10,
} from "@traycer/protocol/host/registry";
import {
  providerCliStateSchema,
  providersListResponseSchema,
  providersListResponseSchemaV10,
  providersListResponseSchemaV20,
  providersListResponseSchemaV60,
  providersListResponseSchemaV70,
  providersSetEnabledRequestSchema,
  providersSetEnabledRequestSchemaV10,
  providersSetEnabledRequestSchemaV21,
  providersSetEnabledResponseSchema,
  providersSetEnabledResponseSchemaV10,
} from "@traycer/protocol/host/provider-schemas";

/**
 * `agent.gui.listHarnesses@7.1` carries exactly one field over 7.0:
 * `authStatus`, the per-row auth verdict the picker dims a signed-out provider
 * with. The line is additive-only and fills nothing on upgrade - ABSENCE of
 * `authStatus` is itself the "this host publishes no verdict on the catalog
 * row" signal the client keys its `providers.list` fallback on, so a fill
 * anywhere in this chain is a real regression, not a convenience.
 *
 * The second half of this suite is the negative: enablement is a plain sticky
 * boolean on every wire, and the tri-state `enablementMode` /
 * `enablementSource` / `setEnabled` `mode` that briefly rode these same lines
 * are gone. Those are asserted absent rather than left untested, because
 * "someone re-adds a derived-enablement field to the live row" is precisely
 * how the behaviour comes back.
 */

// Derived from the schema rather than hand-written: a hand-written union
// silently narrows (an earlier pass omitted `unavailable`, so no test ever
// exercised it) and a future enum member would go untested by omission.
interface HarnessOptionOverrides {
  readonly authStatus?: GuiHarnessOption["authStatus"];
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

function providerState(providerId: string) {
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
  };
}

// ── 1. agent.gui.listHarnesses@7.1 carries authStatus ──────────────────────

describe("agent.gui.listHarnesses@7.1 (authStatus row field)", () => {
  it("the 7.0 -> 7.1 upgrade fills NOTHING - authStatus stays absent", () => {
    const v70Response = listGuiHarnessesResponseSchemaV70.parse({
      harnesses: [harnessOption("claude", {})],
    });
    expect(v70Response.harnesses[0]).not.toHaveProperty("authStatus");

    const upgraded =
      agentGuiListHarnessesUpgradeV70ToV71.upgradeResponse(v70Response);
    expect(upgraded.harnesses[0]).not.toHaveProperty("authStatus");
    // Absence must be distinguishable from every concrete value - a v7.0 host
    // is exactly the host the client's providers.list fallback exists for, and
    // a fill here would fabricate a verdict the client then trusts over that
    // fallback.
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
    "the 7.1 -> %s downgrade strips authStatus while preserving decodable rows",
    (_label, downgrade, responseSchema, rowSchema) => {
      const v71Response = guiHarnessOptionSchemaV71
        .array()
        .parse([harnessOption("claude", { authStatus: "unauthenticated" })]);
      const result = downgrade.downgradeResponse({ harnesses: v71Response });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.harnesses[0]).not.toHaveProperty("authStatus");
      expect(() => responseSchema.parse(result.value)).not.toThrow();
      expect(() => rowSchema.parse(result.value.harnesses[0])).not.toThrow();
    },
  );

  it("the 7.1 -> v1.0 downgrade strips authStatus and every post-v1.0 harness", () => {
    const result = agentGuiListHarnessesDowngradeV7ToV1.downgradeResponse(
      listGuiHarnessesResponseSchemaV71.parse({
        harnesses: [
          harnessOption("claude", { authStatus: "unauthenticated" }),
          harnessOption("grok", {}),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harnesses.map((h) => h.id)).toEqual(["claude"]);
    expect(result.value.harnesses[0]).not.toHaveProperty("authStatus");
    expect(() =>
      listGuiHarnessesResponseSchemaV10.parse(result.value),
    ).not.toThrow();
  });

  it("guiHarnessOptionSchemaV21/V30/V40/V50/V60/V70 do not model authStatus at all - the freeze bug this line fixes", () => {
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
      guiHarnessOptionSchemaV70,
    ]) {
      expect(schema.shape).not.toHaveProperty("authStatus");
    }
    // Only 7.1 and the live row (bound by v8.0, the head) carry it.
    expect(guiHarnessOptionSchemaV71.shape).toHaveProperty("authStatus");
    expect(guiHarnessOptionSchema.shape).toHaveProperty("authStatus");
  });

  it("the v7.0 row is frozen too - a stray authStatus is stripped, not carried", () => {
    const parsed = listGuiHarnessesResponseSchemaV70.parse({
      harnesses: [
        {
          id: "claude",
          label: "claude",
          available: true,
          error: null,
          modes: ["gui" as const],
          requiresApiKey: false,
          // A v7.0 wire payload would never carry this; a real host never sends
          // it on this line, but a strict-schema parse must still strip it if
          // it somehow arrived, exactly like every other frozen line does.
          authStatus: "unauthenticated",
        },
      ],
    });
    expect(parsed.harnesses[0]).not.toHaveProperty("authStatus");
  });

  it("forward tolerance: an unknown authStatus drops that field, not the row", () => {
    // `.optional()` alone is not enough: nothing on the path to the array
    // element catches, so a value a NEWER host minted would fail the whole
    // response and empty the client's picker over one field it could have
    // ignored. Negotiation is meant to make that unreachable (a newer host
    // downgrades to the negotiated minor); this is the defense in depth behind
    // that assumption, which this very line has already broken twice.
    const parsed = guiHarnessOptionSchema.parse({
      id: "claude",
      label: "claude",
      available: true,
      error: null,
      modes: ["gui"],
      requiresApiKey: false,
      authStatus: "some-future-status",
    });
    expect(parsed.id).toBe("claude");
    expect(parsed.available).toBe(true);
    // The unreadable field reads exactly like an old host's absence, which is
    // the fallback the client already implements.
    expect(parsed.authStatus).toBeUndefined();
  });
});

// ── 2. Enablement is a sticky boolean on every wire ────────────────────────

describe("enablement carries no derived-mode field on any line", () => {
  it("no provider or harness row models enablementMode/enablementSource", () => {
    // The pair rode `providerCliStateBaseShape` and the live harness row for
    // one unreleased revision. Re-adding either is how the tri-state UI and the
    // mid-session flipping come back, so the absence is pinned rather than
    // merely deleted.
    for (const schema of [
      providerCliStateSchema,
      guiHarnessOptionSchema,
      guiHarnessOptionSchemaV71,
      guiHarnessOptionSchemaV70,
    ]) {
      expect(schema.shape).not.toHaveProperty("enablementMode");
      expect(schema.shape).not.toHaveProperty("enablementSource");
    }
    // `enabled` is what remains, and it is a plain REQUIRED boolean: a client
    // reads the user's sticky choice and nothing else.
    expect(providerCliStateSchema.shape).toHaveProperty("enabled");
    expect(
      providerCliStateSchema.safeParse({
        ...providerState("claude-code"),
        enabled: undefined,
      }).success,
    ).toBe(false);
  });

  it("a stray enablement field on the wire is stripped, and the row survives", () => {
    // The row must not vanish over a key from a build that still emits the
    // retired pair - the same stripped-NOT-dropped distinction the v1.0
    // downgrade trap turns on.
    const response = providersListResponseSchema.parse({
      providers: [
        providerState("claude-code"),
        {
          ...providerState("codex"),
          enablementMode: "auto",
          enablementSource: "auto-undetected",
        },
      ],
      native: null,
    });
    expect(response.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(response.providers[1]).not.toHaveProperty("enablementMode");
    expect(response.providers[1]).not.toHaveProperty("enablementSource");
    expect(response.providers[1]?.enabled).toBe(true);
  });

  it("providers.setEnabled's live request is providerId + enabled, with no mode", () => {
    expect(providersSetEnabledRequestSchema.shape).not.toHaveProperty("mode");
    expect(providersSetEnabledRequestSchemaV21.shape).not.toHaveProperty(
      "mode",
    );
    const parsed = providersSetEnabledRequestSchemaV21.parse({
      providerId: "claude-code",
      enabled: false,
      profileAction: null,
      // A caller that still sends `mode` gets it stripped rather than honoured:
      // there is no derived state left for it to select.
      mode: "auto",
    });
    expect(parsed).not.toHaveProperty("mode");
    expect(parsed.enabled).toBe(false);
  });

  it("the registered 2.1 -> v1.0 downgrade drops profileAction - v1.0's strict request would otherwise reject the whole call", () => {
    const v21Request = providersSetEnabledRequestSchemaV21.parse({
      providerId: "claude-code",
      enabled: false,
      profileAction: null,
    });
    // A leaked key fails v1.0's strict parse outright.
    expect(
      providersSetEnabledRequestSchemaV10.safeParse(v21Request).success,
    ).toBe(false);

    const downgraded =
      providersSetEnabledDowngradeV21ToV10.downgradeRequest(v21Request);
    expect(downgraded).toMatchObject({
      ok: true,
      value: { providerId: "claude-code", enabled: false },
    });
    if (!downgraded.ok) return;
    expect(downgraded.value).not.toHaveProperty("profileAction");
    expect(() =>
      providersSetEnabledRequestSchemaV10.parse(downgraded.value),
    ).not.toThrow();
  });

  it("the 2.1 -> v1.0 downgrade response echo still strips to the frozen v1.0 state shape", () => {
    const state = providersListResponseSchema.parse({
      providers: [providerState("claude-code")],
      native: null,
    }).providers[0];
    const downgraded = providersSetEnabledDowngradeV21ToV10.downgradeResponse(
      providersSetEnabledResponseSchema.parse({ state }),
    );
    expect(downgraded.ok).toBe(true);
    if (!downgraded.ok) return;
    expect(() =>
      providersSetEnabledResponseSchemaV10.parse(downgraded.value),
    ).not.toThrow();
  });
});

// ── 3. providers.list keeps its v7 bridges after 7.1 went away ─────────────

describe("providers.list major 7 downgrades still carry rows after the 7.1 line was removed", () => {
  // The six v7 -> older bridges were declared `from: 7.1` while that minor
  // existed; they now start at 7.0, which is what the registry's
  // "a downgrade must start at the line's latest minor" load check enforces.
  // These exercise the two ends of that range, plus the v1.0 strict-parse trap.
  it("7.0 -> v6.0 preserves the row and its effective enabled flag", () => {
    const v70Response = providersListResponseSchemaV70.parse({
      providers: [providerState("claude-code")],
      native: null,
    });
    const result = providersListDowngradeV7ToV6.downgradeResponse(v70Response);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers[0]?.enabled).toBe(true);
    expect(() =>
      providersListResponseSchemaV60.parse(result.value),
    ).not.toThrow();
  });

  it("7.0 -> v2.0 preserves the row", () => {
    const result = providersListDowngradeV7ToV2.downgradeResponse(
      providersListResponseSchemaV70.parse({
        providers: [providerState("claude-code")],
        native: null,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.providers.map((p) => p.providerId)).toEqual([
      "claude-code",
    ]);
    expect(() =>
      providersListResponseSchemaV20.parse(result.value),
    ).not.toThrow();
  });

  // REGRESSION PIN for a defect this suite caught. `downgradeProviderCliStateToV10`
  // destructures every post-v1.0 field off the row before the STRICT
  // `providerCliStateSchemaV10` parse, and its own comment warns that a field
  // left out of that destructure "does not fail loudly - it empties the provider
  // list for v1.0 clients". The (now removed) enablement pair was duly forgotten
  // on its first pass and the WHOLE ROW vanished. So this asserts
  // stripped-NOT-vanished, which is the distinction the defect turned on and the
  // one a future field will get wrong the same way.
  it("7.0 -> v1.0 PRESERVES a decodable row, dropping only the post-v1.0 provider", () => {
    const result = providersListDowngradeV7ToV1.downgradeResponse(
      providersListResponseSchemaV70.parse({
        providers: [providerState("claude-code"), providerState("grok")],
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

// ── 4. Registry loads with the expected latestMinor per line ───────────────

describe("hostRpcRegistry loads with the catalog lines at their expected latestMinor", () => {
  // Module-load validation already enforces "a downgrade must start at the
  // line's latest minor" - importing the registry at all would throw if that
  // were violated. This makes the expectation a legible, named assertion
  // rather than relying on the import succeeding silently.
  it("agent.gui.listHarnesses major 7 -> latestMinor 1 (authStatus)", () => {
    expect(hostRpcRegistry["agent.gui.listHarnesses"][7].latestMinor).toBe(1);
    expect(
      hostRpcRegistry["agent.gui.listHarnesses"][7].versions[1],
    ).toBeDefined();
  });

  it("providers.list major 7 -> latestMinor 0 (no 7.1 line exists)", () => {
    expect(hostRpcRegistry["providers.list"][7].latestMinor).toBe(0);
    expect(Object.keys(hostRpcRegistry["providers.list"][7].versions)).toEqual([
      "0",
    ]);
  });

  it("providers.setEnabled major 2 -> latestMinor 1 (no 2.2 line exists)", () => {
    expect(hostRpcRegistry["providers.setEnabled"][2].latestMinor).toBe(1);
    expect(
      Object.keys(hostRpcRegistry["providers.setEnabled"][2].versions),
    ).toEqual(["0", "1"]);
    // The downgrade-from-latest table points back at the 2.1 bridge.
    expect(
      hostRpcRegistry["providers.setEnabled"][2].downgradePathsFromLatest[1],
    ).toBe(providersSetEnabledDowngradeV21ToV10);
  });
});
