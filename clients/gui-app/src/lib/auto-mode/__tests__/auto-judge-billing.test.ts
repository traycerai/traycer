import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import { guiHarnessOptionSchema } from "@traycer/protocol/host/agent/gui/unary-schemas";
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
  harnessHasNativeAutoJudge,
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

/**
 * A catalog row for the native-judge capability half of
 * `providerRunsItsOwnJudge`. Built through the real schema so a field added to
 * `guiHarnessOptionSchema` cannot silently leave this fixture behind, and
 * defaulted to CAPABLE - every pre-existing case below asserts the stored
 * override's effect, so the capability must not be what decides them.
 */
function harnessRow(overrides: {
  readonly nativeAutoJudge: boolean;
}): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge: overrides.nativeAutoJudge,
  });
}

const CAPABLE_HARNESSES: ReadonlyArray<GuiHarnessOption> = [
  harnessRow({ nativeAutoJudge: true }),
];

const INCAPABLE_HARNESSES: ReadonlyArray<GuiHarnessOption> = [
  harnessRow({ nativeAutoJudge: false }),
];

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
      "Judge calls are Copilot premium requests, charged to your monthly allowance — an hour of Auto mode can use 60–350 of it.",
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
      "Judge calls use your own Claude Code account, on top of your chat replies — a reviewed command can take more than one call.",
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
        harnesses: CAPABLE_HARNESSES,
      }),
    ).toBe(true);
  });

  it("is false for a provider row whose stored autoJudge is 'traycer'", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "traycer" })],
        harnesses: CAPABLE_HARNESSES,
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
        harnesses: CAPABLE_HARNESSES,
      }),
    ).toBe(false);
  });

  it("is false when the providers list has not loaded yet (providers: undefined)", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: undefined,
        harnesses: CAPABLE_HARNESSES,
      }),
    ).toBe(false);
  });

  it("is false when harnessId is null - no run harness to look up", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: null,
        providers: [providerState({ autoJudge: "provider" })],
        harnesses: CAPABLE_HARNESSES,
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
        harnesses: CAPABLE_HARNESSES,
      }),
    ).toBe(false);
  });

  // The defect this field exists to fix: `autoJudge` is a PREFERENCE that
  // outlives the CAPABILITY it once delegated to (a host downgrade, or a
  // provider that lost the feature), so the stored "provider" selection alone
  // must not be enough - the catalog row has to say the classifier still
  // exists.
  it("is false for a stored 'provider' selection when the catalog row is not capable (nativeAutoJudge: false)", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "provider" })],
        harnesses: INCAPABLE_HARNESSES,
      }),
    ).toBe(false);
  });

  it("is false when the harness catalog has not loaded yet (harnesses: undefined)", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "provider" })],
        harnesses: undefined,
      }),
    ).toBe(false);
  });

  it("is false when no catalog row matches the harness id", () => {
    expect(
      providerRunsItsOwnJudge({
        harnessId: CLAUDE_HARNESS_ID,
        providers: [providerState({ autoJudge: "provider" })],
        harnesses: [
          guiHarnessOptionSchema.parse({
            id: "codex",
            label: "Codex",
            available: true,
            error: null,
            modes: ["gui"],
            requiresApiKey: false,
            nativeAutoJudge: true,
          }),
        ],
      }),
    ).toBe(false);
  });
});

// Extracted from `providerRunsItsOwnJudge` because a second caller
// (`useAutoJudgeBilling`'s `providerJudgeUnknown`) now needs the same
// question for a different purpose - see the doc on the function.
describe("harnessHasNativeAutoJudge", () => {
  it("is true for a matching row with nativeAutoJudge: true", () => {
    expect(
      harnessHasNativeAutoJudge(CLAUDE_HARNESS_ID, CAPABLE_HARNESSES),
    ).toBe(true);
  });

  it("is false when no row matches the harness id", () => {
    expect(
      harnessHasNativeAutoJudge(CLAUDE_HARNESS_ID, [
        guiHarnessOptionSchema.parse({
          id: "codex",
          label: "Codex",
          available: true,
          error: null,
          modes: ["gui"],
          requiresApiKey: false,
          nativeAutoJudge: true,
        }),
      ]),
    ).toBe(false);
  });

  it("is false for a matching row with nativeAutoJudge: false", () => {
    expect(
      harnessHasNativeAutoJudge(CLAUDE_HARNESS_ID, INCAPABLE_HARNESSES),
    ).toBe(false);
  });

  it("is false when harnessId is null", () => {
    expect(harnessHasNativeAutoJudge(null, CAPABLE_HARNESSES)).toBe(false);
  });

  it("is false when the harness catalog has not loaded yet (undefined)", () => {
    expect(harnessHasNativeAutoJudge(CLAUDE_HARNESS_ID, undefined)).toBe(false);
  });
});

describe("autoJudgeBillingForRun", () => {
  it("resolves to provider-native for the RUN harness even when judgeHarnessId is 'traycer' - the defect this exists to fix", () => {
    expect(
      autoJudgeBillingForRun({
        judgeHarnessId: "traycer",
        runHarnessId: "claude",
        isProviderNative: true,
        blocked: null,
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
        blocked: null,
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
        blocked: null,
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

describe("autoJudgeBillingForRun (blocked)", () => {
  const BLOCKED_REASONS = [
    "provider-disabled",
    "no-default",
    "unsupported-harness",
  ] as const;

  // A REAL, non-traycer `judgeHarnessId` on every case - the defect this
  // guards against was a stored provider selection getting billed to that
  // provider's account even though the host had already said it cannot run
  // that judge. With `judgeHarnessId: "traycer"` the fall-through case and
  // the blocked case would look identical, so the choice of fixture matters.
  it.each(BLOCKED_REASONS)(
    "resolves to blocked for reason '%s' - a stored provider judge must not be billed once the host reports it cannot run",
    (reason) => {
      expect(
        autoJudgeBillingForRun({
          judgeHarnessId: "claude",
          runHarnessId: "codex",
          isProviderNative: false,
          blocked: { reason },
        }),
      ).toEqual({ kind: "blocked" });
    },
  );

  // Wire-compat: an older host that predates the `blocked` field omits it
  // rather than sending `null`, and `autoJudgeBillingForRun` must treat the
  // two identically so an old host's disclosure doesn't regress to "blocked"
  // by default.
  it("treats blocked: undefined exactly like blocked: null", () => {
    const input = {
      judgeHarnessId: "claude",
      runHarnessId: "codex",
      isProviderNative: false,
    };
    const withNull = autoJudgeBillingForRun({ ...input, blocked: null });
    const withUndefined = autoJudgeBillingForRun({
      ...input,
      blocked: undefined,
    });

    expect(withUndefined).toEqual(withNull);
    expect(withUndefined).toEqual(autoJudgeBillingFor("claude"));
  });

  // Precedence: provider-native wins over a blocker on Traycer's judge. That
  // provider's own classifier decides inside the agent turn regardless of
  // what Traycer's judge can or can't run, so a blocker here describes a call
  // that was never going to happen - reporting "blocked" would tell the user
  // nothing reviews their commands when the provider itself does, for free.
  it("resolves to provider-native, not blocked, when the run is provider-native and the host also reports a blocker", () => {
    expect(
      autoJudgeBillingForRun({
        judgeHarnessId: "traycer",
        runHarnessId: "claude",
        isProviderNative: true,
        blocked: { reason: "no-default" },
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });
});

describe("autoJudgeMetaLine / autoJudgeSelfBillingWarning (blocked)", () => {
  it("autoJudgeMetaLine tells the user no judge will run for the blocked kind", () => {
    expect(autoJudgeMetaLine({ kind: "blocked" })).toBe(
      "No judge can run on this machine, so Auto mode will ask you.",
    );
  });

  it("autoJudgeSelfBillingWarning returns null for the blocked kind - nothing is spent when nothing runs", () => {
    expect(autoJudgeSelfBillingWarning({ kind: "blocked" })).toBeNull();
  });
});
