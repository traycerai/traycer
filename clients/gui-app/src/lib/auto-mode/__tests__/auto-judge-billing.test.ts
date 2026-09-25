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
  autoJudgeTarget,
  autoModeMidTurnLock,
  harnessHasNativeAutoJudge,
  providerRunsItsOwnJudge,
  type AutoJudgeBilling,
  type AutoJudgeTarget,
  type AutoJudgeTargetInput,
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
  readonly judgeDefaultModel?: string | null;
}): GuiHarnessOption {
  return guiHarnessOptionSchema.parse({
    id: CLAUDE_HARNESS_ID,
    label: "Claude Code",
    available: true,
    error: null,
    modes: ["gui"],
    requiresApiKey: false,
    nativeAutoJudge: overrides.nativeAutoJudge,
    judgeDefaultModel: overrides.judgeDefaultModel ?? null,
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

  it("is false when the row carries no autoJudge key at all (a host predating providers.list@9.1)", () => {
    const row = providerState({});
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

describe("autoJudgeTarget", () => {
  const BASE_INPUT: AutoJudgeTargetInput = {
    selection: null,
    effective: undefined,
    blocked: undefined,
    runHarnessId: null,
    runModelSlug: "",
    runJudgeDefaultModel: null,
  };

  it("is 'none' whatever blocked says, when effective is null", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: null,
        blocked: { reason: "provider-disabled" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("is 'none' when effective is undefined but blocked names a reason", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: undefined,
        blocked: { reason: "unsupported-harness" },
      }),
    ).toEqual({ kind: "none" });
  });

  it("resolves the stored selection when effective is undefined (a pre-1.1 host) and a selection exists", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        selection: { harnessId: "claude", model: "sonnet", profileId: null },
        effective: undefined,
        blocked: undefined,
      }),
    ).toEqual({ kind: "judge", harnessId: "claude", modelSlug: "sonnet" });
  });

  it("is 'unknown' when effective is undefined and there is no stored selection", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        selection: null,
        effective: undefined,
        blocked: undefined,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("resolves selection/default sources directly from effective", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: {
          harnessId: "traycer",
          model: "sonnet-5",
          source: "default",
        },
      }),
    ).toEqual({ kind: "judge", harnessId: "traycer", modelSlug: "sonnet-5" });

    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { harnessId: "claude", model: "opus", source: "selection" },
      }),
    ).toEqual({ kind: "judge", harnessId: "claude", modelSlug: "opus" });
  });

  it("under fallback, names the run harness's judgeDefaultModel when it has one", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: "claude",
        runModelSlug: "sonnet-in-composer",
        runJudgeDefaultModel: "claude-judge-default",
      }),
    ).toEqual({
      kind: "judge",
      harnessId: "claude",
      modelSlug: "claude-judge-default",
    });
  });

  it("under fallback, falls back to the composer's own model when the run harness names no judge default", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: "claude",
        runModelSlug: "sonnet-in-composer",
        runJudgeDefaultModel: null,
      }),
    ).toEqual({
      kind: "judge",
      harnessId: "claude",
      modelSlug: "sonnet-in-composer",
    });
  });

  // The wire accepts `judgeDefaultModel: ""`, and Settings' `defaultJudgeModelFor`
  // reads it as "no default"; the composer must reach the same answer for the
  // same row rather than naming a blank model.
  it("under fallback, reads an empty judgeDefaultModel as no default and names the composer's model", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: "claude",
        runModelSlug: "sonnet-in-composer",
        runJudgeDefaultModel: "",
      }),
    ).toEqual({
      kind: "judge",
      harnessId: "claude",
      modelSlug: "sonnet-in-composer",
    });
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: "claude",
        runModelSlug: "",
        runJudgeDefaultModel: "",
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("under fallback, is 'unknown' when there is no run harness", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: null,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("under fallback, is 'unknown' when there is neither a judge default model nor a composer model", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        runHarnessId: "claude",
        runModelSlug: "",
        runJudgeDefaultModel: null,
      }),
    ).toEqual({ kind: "unknown" });
  });

  // Finding: under Automatic's fallback, a conversation that itself runs on
  // the `traycer` harness has NO fallback judge - the host's
  // `autoJudgeCandidates` excludes a second Traycer candidate, so the person
  // is asked. `autoJudgeTarget` must recognise `runHarnessId === "traycer"`
  // under `source: "fallback"` and answer 'none' rather than naming a
  // traycer judge for a traycer-hosted run.
  it("is 'none' under Automatic's fallback when the run itself is on the traycer harness - no second Traycer candidate exists", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        blocked: null,
        runHarnessId: "traycer",
        runModelSlug: "traycer:some-model",
        runJudgeDefaultModel: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("is 'none' under the same fallback even when the traycer harness's own catalog names a judgeDefaultModel", () => {
    expect(
      autoJudgeTarget({
        ...BASE_INPUT,
        effective: { source: "fallback" },
        blocked: null,
        runHarnessId: "traycer",
        runModelSlug: "traycer:some-model",
        runJudgeDefaultModel: "traycer:judge",
      }),
    ).toEqual({ kind: "none" });
  });

  it("composes to 'blocked' billing and the no-judge meta line for a traycer-hosted run under fallback", () => {
    const target = autoJudgeTarget({
      ...BASE_INPUT,
      effective: { source: "fallback" },
      blocked: null,
      runHarnessId: "traycer",
      runModelSlug: "traycer:some-model",
      runJudgeDefaultModel: null,
    });
    const billing = autoJudgeBillingForRun({
      runHarnessId: "traycer",
      isProviderNative: false,
      target,
      judgeModelLabel: null,
      judgeRecordUnrunnable: false,
    });
    if (billing === null) {
      throw new Error("expected a billing verdict, got null");
    }
    expect(billing).toEqual({ kind: "blocked" });
    expect(autoJudgeMetaLine(billing)).toBe(
      "No judge available on this machine · asks you instead",
    );
  });

  // Provider-native precedence is unaffected by the fix above: a run whose
  // OWN provider reviews its own commands never consults the traycer-hosted
  // fallback question at all. Probably already green.
  it("keeps provider-native precedence for a run on the file's own CLAUDE_HARNESS_ID constant, whatever the target names", () => {
    const billing = autoJudgeBillingForRun({
      runHarnessId: CLAUDE_HARNESS_ID,
      isProviderNative: true,
      target: { kind: "none" },
      judgeModelLabel: null,
      judgeRecordUnrunnable: false,
    });
    expect(billing).toEqual({
      kind: "provider-native",
      harnessId: CLAUDE_HARNESS_ID,
      harnessLabel: "Claude Code",
    });
  });
});

describe("autoJudgeBillingForRun", () => {
  const JUDGE_TARGET: AutoJudgeTarget = {
    kind: "judge",
    harnessId: "claude",
    modelSlug: "sonnet",
  };

  it("resolves to provider-native for the RUN harness whatever the target names", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "claude",
        isProviderNative: true,
        target: { kind: "judge", harnessId: "traycer", modelSlug: "sonnet-5" },
        judgeModelLabel: null,
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  it("resolves to blocked when the target is 'none', whatever else is true", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: { kind: "none" },
        judgeModelLabel: null,
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("provider-native takes precedence over a 'none' target", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "claude",
        isProviderNative: true,
        target: { kind: "none" },
        judgeModelLabel: null,
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  it("resolves to blocked when judgeRecordUnrunnable is true, even for an otherwise-named target", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: JUDGE_TARGET,
        judgeModelLabel: "Sonnet",
        judgeRecordUnrunnable: true,
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("provider-native takes precedence over judgeRecordUnrunnable", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "claude",
        isProviderNative: true,
        target: JUDGE_TARGET,
        judgeModelLabel: "Sonnet",
        judgeRecordUnrunnable: true,
      }),
    ).toEqual({
      kind: "provider-native",
      harnessId: "claude",
      harnessLabel: "Claude Code",
    });
  });

  it("returns null for an unknown target", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: { kind: "unknown" },
        judgeModelLabel: null,
        judgeRecordUnrunnable: false,
      }),
    ).toBeNull();
  });

  it("resolves to traycer with the model label, when the target's harness bills to traycer", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: { kind: "judge", harnessId: "traycer", modelSlug: "sonnet-5" },
        judgeModelLabel: "Sonnet 5",
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({ kind: "traycer", modelLabel: "Sonnet 5" });
  });

  it("resolves to provider with the model label, when the target's harness bills to a provider account", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: JUDGE_TARGET,
        judgeModelLabel: "Sonnet",
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
      modelLabel: "Sonnet",
    });
  });

  it("falls back to the raw model slug for modelLabel when the catalog has no row for it", () => {
    expect(
      autoJudgeBillingForRun({
        runHarnessId: "codex",
        isProviderNative: false,
        target: JUDGE_TARGET,
        judgeModelLabel: null,
        judgeRecordUnrunnable: false,
      }),
    ).toEqual({
      kind: "provider",
      harnessId: "claude",
      harnessLabel: "Claude Code",
      modelLabel: "sonnet",
    });
  });
});

describe("autoJudgeMetaLine", () => {
  it("names the model and Traycer credits for the traycer kind", () => {
    expect(autoJudgeMetaLine({ kind: "traycer", modelLabel: "Sonnet 5" })).toBe(
      "Reviewed by Sonnet 5 on Traycer · uses credits",
    );
  });

  it("names the model and the provider's own account for the provider kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider",
        harnessId: "claude",
        harnessLabel: "Claude Code",
        modelLabel: "Sonnet",
      }),
    ).toBe("Reviewed by Sonnet on Claude Code · your account");
  });

  it("names the premium-request range for the Copilot provider kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider",
        harnessId: "copilot",
        harnessLabel: "Copilot",
        modelLabel: "GPT-5",
      }),
    ).toBe(
      "Reviewed by GPT-5 on Copilot · uses premium requests (60–350 per hour)",
    );
  });

  it("names the provider's own classifier, at no extra cost, for the provider-native kind", () => {
    expect(
      autoJudgeMetaLine({
        kind: "provider-native",
        harnessId: "claude",
        harnessLabel: "Claude Code",
      }),
    ).toBe("Reviewed by Claude Code's built-in classifier · no extra cost");
  });

  it("says no judge is available for the blocked kind", () => {
    expect(autoJudgeMetaLine({ kind: "blocked" })).toBe(
      "No judge available on this machine · asks you instead",
    );
  });
});

describe("autoModeMidTurnLock", () => {
  const PROVIDER_NATIVE_BILLING: AutoJudgeBilling = {
    kind: "provider-native",
    harnessId: "claude",
    harnessLabel: "Claude Code",
  };

  it("locks with the exact sentence when a turn is active, the current mode isn't auto, and billing is provider-native", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: false,
        judgeBilling: PROVIDER_NATIVE_BILLING,
      }),
    ).toBe(
      "Claude Code's built-in classifier starts with your next turn. To switch now, pick Traycer's judge in Permission settings.",
    );
  });

  it("is null when no turn is active, even for provider-native billing", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: false,
        currentModeIsAuto: false,
        judgeBilling: PROVIDER_NATIVE_BILLING,
      }),
    ).toBeNull();
  });

  it("is null when the current mode is already auto, even for provider-native billing", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: true,
        judgeBilling: PROVIDER_NATIVE_BILLING,
      }),
    ).toBeNull();
  });

  it("is null for traycer billing", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: false,
        judgeBilling: { kind: "traycer", modelLabel: "Sonnet 5" },
      }),
    ).toBeNull();
  });

  it("is null for provider billing", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: false,
        judgeBilling: {
          kind: "provider",
          harnessId: "claude",
          harnessLabel: "Claude Code",
          modelLabel: "Sonnet",
        },
      }),
    ).toBeNull();
  });

  it("is null for blocked billing", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: false,
        judgeBilling: { kind: "blocked" },
      }),
    ).toBeNull();
  });

  it("is null when judgeBilling is null (still loading)", () => {
    expect(
      autoModeMidTurnLock({
        turnActive: true,
        currentModeIsAuto: false,
        judgeBilling: null,
      }),
    ).toBeNull();
  });
});
