import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_NATIVE_CAPABILITIES,
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import {
  guiHarnessIdToProviderId,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import {
  autoJudgeBillingFor,
  autoJudgeBillingForRun,
  autoJudgeMetaLine,
  autoJudgeSelfBillingWarning,
  providerRunsItsOwnJudge,
} from "@/lib/auto-mode/auto-judge-billing";

const CLAUDE_HARNESS_ID = providerIdToGuiHarnessId("claude-code");

/**
 * The full `ProviderCliState` shape, exactly as
 * `provider-auto-judge-section.test.tsx` builds one - there is no zod-schema
 * fixture helper for this type in the suite yet, so this mirrors that one
 * rather than inventing a second shape.
 */
function providerState(overrides: Partial<ProviderCliState>): ProviderCliState {
  return {
    providerId: "claude-code",
    enabled: true,
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
    ...overrides,
  };
}

describe("autoJudgeBillingFor", () => {
  it("resolves null (unset) to traycer - the host's own fallback", () => {
    expect(autoJudgeBillingFor(null)).toEqual({ kind: "traycer" });
  });

  it("resolves the traycer harness id to traycer", () => {
    expect(autoJudgeBillingFor("traycer")).toEqual({ kind: "traycer" });
  });

  it("resolves a known provider harness to its display label", () => {
    const providerId = guiHarnessIdToProviderId("claude");
    expect(providerId).not.toBeNull();
    const expectedLabel =
      providerId === null ? "claude" : PROVIDER_DISPLAY_NAMES[providerId];

    expect(autoJudgeBillingFor("claude")).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: expectedLabel,
    });
  });

  it("falls back to the raw harness id as the label when it isn't in the provider catalog", () => {
    expect(autoJudgeBillingFor("some-unknown-harness")).toEqual({
      kind: "provider",
      harnessId: "some-unknown-harness",
      harnessLabel: "some-unknown-harness",
    });
  });
});

describe("autoJudgeSelfBillingWarning", () => {
  it("returns null when the judge is Traycer's own - nothing of the user's is spent", () => {
    expect(autoJudgeSelfBillingWarning({ kind: "traycer" })).toBeNull();
  });

  it("quotes Traycer's own Copilot premium-request call rate for the copilot harness", () => {
    expect(
      autoJudgeSelfBillingWarning({
        kind: "provider",
        harnessId: "copilot",
        harnessLabel: "Copilot",
      }),
    ).toBe(
      "Judge calls are Copilot premium requests — one per command reviewed, so an hour of Auto mode can use 60–350 of your monthly allowance.",
    );
  });

  it("states the generic 'on top of your chat replies' sentence for any other provider harness", () => {
    expect(
      autoJudgeSelfBillingWarning({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe(
      "Judge calls use your own Claude Code account, once per command reviewed — on top of your chat replies.",
    );
  });
});

describe("autoJudgeMetaLine", () => {
  it("names Traycer credits for the traycer kind", () => {
    expect(autoJudgeMetaLine({ kind: "traycer" })).toBe(
      "Uses your Traycer credits.",
    );
  });

  it("names the provider's own account for the provider kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe("Uses your Claude Code account.");
  });

  it("names the provider's own classifier, at no extra cost, for the provider-native kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider-native",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe("Reviewed by Claude Code's own classifier — no extra cost.");
  });
});

describe("providerRunsItsOwnJudge", () => {
  it("is true for a provider row whose stored autoJudge is 'provider'", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "provider" })],
      }),
    ).toBe(true);
  });

  it("is false for a provider row whose stored autoJudge is 'traycer'", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "traycer" })],
      }),
    ).toBe(false);
  });

  // The important one: a host old enough to predate `providers.list@9.1`
  // omits the key entirely rather than defaulting it, and `providerAutoJudgeFor`'s
  // `?? "traycer"` is what turns an ABSENT key into the same false this test
  // asserts - not a coincidence, the one read seam that fallback lives behind.
  it("is false when the row carries no autoJudge key at all (a host predating providers.list@9.1)", () => {
    const row = providerState({});
    // `autoJudge` is `.optional()` on the wire; asserting the key is really
    // absent (not merely undefined-valued) is what makes this case distinct
    // from the "traycer" case above rather than a restatement of it.
    expect("autoJudge" in row).toBe(false);

    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [row],
      }),
    ).toBe(false);
  });

  it("is false when the providers list has not loaded yet (providers: undefined)", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: undefined,
      }),
    ).toBe(false);
  });

  it("is false when harnessId is null - no run harness to look up", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: null,
        providers: [providerState({ autoJudge: "provider" })],
      }),
    ).toBe(false);
  });

  it("is false when no provider row matches the harness", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [
          providerState({ providerId: "codex", autoJudge: "provider" }),
        ],
      }),
    ).toBe(false);
  });
});

describe("autoJudgeBillingForRun", () => {
  it("resolves to provider-native for the RUN harness even when judgeHarnessId is 'traycer' - the defect this exists to fix", () => {
    expect(
      autoJudgeBillingForRun({
        judgeHarnessId: "traycer",
        runHarnessId: "claude",
        isProviderNative: true,
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  it("resolves to provider-native for the RUN harness even when judgeHarnessId names a different provider", () => {
    expect(
      autoJudgeBillingForRun({
        judgeHarnessId: "copilot",
        runHarnessId: "claude",
        isProviderNative: true,
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  it("falls through to autoJudgeBillingFor(judgeHarnessId) when isProviderNative is false", () => {
    expect(
      autoJudgeBillingForRun({
        judgeHarnessId: "claude",
        runHarnessId: "codex",
        isProviderNative: false,
      }),
    ).toEqual(autoJudgeBillingFor("claude"));
  });
});

describe("autoJudgeSelfBillingWarning (provider-native)", () => {
  it("returns null for the provider-native kind - nothing extra is spent, the provider reviews for free", () => {
    expect(
      autoJudgeSelfBillingWarning({
        kind: "provider-native",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBeNull();
  });
});
