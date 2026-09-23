/**
 * The pure half of Settings ▸ Permissions ▸ Judge: what a choice of provider
 * commits, which providers and accounts can run a judge today, and what is
 * wrong with the stored judge record.
 *
 * Kept apart from the tab because a module that exports a component may
 * export nothing else - fast refresh replaces the whole module, so
 * `react(only-export-components)` fails a build over a helper living beside
 * one. These are also the pieces worth testing without rendering anything.
 */
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  modelMatchIsCovered,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";
import {
  isProfileEnabled,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type {
  AutoJudgeBlocked,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";

/**
 * Why a provider cannot run a judge on this machine today, as the Provider
 * field's disabled row says it. `null` when it can.
 *
 * Checked in the order a fix has to happen: a provider that is turned off is
 * that first, whatever else is wrong with it; one that is signed out is
 * installed; and "not installed" is only claimed once availability has
 * SETTLED - a pending probe is not evidence of anything.
 */
export type JudgeProviderBlocker =
  | "Turned off"
  | "Signed out"
  | "Not installed"
  | "Not available";

export function judgeProviderBlocker(
  row: GuiHarnessOption,
): JudgeProviderBlocker | null {
  if (!row.enabled) return "Turned off";
  if (
    row.authStatus === "unauthenticated" ||
    row.unavailableReason === "missing-credential"
  ) {
    return "Signed out";
  }
  if (row.available || row.availabilityPending) return null;
  return row.unavailableReason === "other" ? "Not available" : "Not installed";
}

/**
 * Why one account of a provider cannot run the judge, or `null` when it can:
 * an account turned off host-wide, or one whose provider takes an API key and
 * has none stored for it.
 */
export function judgeProfileBlocker(profile: ProviderProfile): string | null {
  if (!isProfileEnabled(profile)) return "Turned off";
  const apiKey = profile.apiKey ?? null;
  if (apiKey !== null && apiKey.supported && !apiKey.configured) {
    return "No API key";
  }
  return null;
}

/** The provider state behind a catalog row, or `undefined` when unknown. */
export function providerForHarness(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: string,
): ProviderCliState | undefined {
  // Projected provider -> harness: the total `providerIdToGuiHarnessId` needs
  // no narrowing of the plain string the stored record carries.
  return providers?.find(
    (candidate) => providerIdToGuiHarnessId(candidate.providerId) === harnessId,
  );
}

/**
 * The account a newly chosen provider judges on: its first account that can
 * run one, as a COMMIT id (ambient is `null`, never the wire sentinel). `null`
 * - the ambient login - when `providers.list` has not answered or the provider
 * offers no runnable account, which is what the host falls back to anyway.
 */
export function firstOfferedJudgeProfileId(
  provider: ProviderCliState | undefined,
): string | null {
  const profile = provider?.profiles.find(
    (candidate) => judgeProfileBlocker(candidate) === null,
  );
  return profile === undefined ? null : profileCommitId(profile);
}

/**
 * The model a newly chosen provider judges on: the row's `judgeDefaultModel`
 * when it names one, else its catalog's first model - adapters list their
 * recommended model first, and there is no "default" flag to read instead.
 * `null` when neither is known yet: the catalog has not answered, and the
 * caller waits for it rather than committing a guess.
 */
export function defaultJudgeModelFor(
  row: GuiHarnessOption,
  models: ReadonlyArray<GuiAgentModelOption> | undefined,
): string | null {
  const named = row.judgeDefaultModel ?? null;
  if (named !== null && named.length > 0) return named;
  return models?.at(0)?.slug ?? null;
}

/**
 * The selection a choice of provider commits: that provider, its default judge
 * model and its first runnable account. `null` while the model is not known.
 */
export function judgeSelectionForProvider(input: {
  readonly row: GuiHarnessOption;
  readonly models: ReadonlyArray<GuiAgentModelOption> | undefined;
  readonly provider: ProviderCliState | undefined;
}): AutoJudgeSelection | null {
  const model = defaultJudgeModelFor(input.row, input.models);
  if (model === null) return null;
  return {
    harnessId: input.row.id,
    model,
    profileId: firstOfferedJudgeProfileId(input.provider),
  };
}

/**
 * The first thing wrong with a stored judge, in the order it is reported: the
 * single decision the Judge tab's one warning line is chosen from.
 */
export type JudgeWarningCause =
  | { readonly kind: "provider-disabled" }
  | { readonly kind: "unsupported-harness" }
  | { readonly kind: "unrecognized" }
  | { readonly kind: "provider"; readonly blocker: JudgeProviderBlocker }
  | { readonly kind: "model" }
  | { readonly kind: "profile" };

/**
 * What is wrong with the stored judge record, or `null` when it can run.
 *
 * The host's own `blocked` verdict first, since it is the one the host acts
 * on; then a harness this build does not know; then the stored provider, whose
 * models and accounts going with it are consequences, not second findings;
 * then the model, then the account.
 *
 * Every catalog answers "only when we actually know": a harness catalog, a
 * model catalog or a providers read that has not answered is `undefined`, and
 * `undefined` is never evidence that something is gone - so nothing is
 * reported past the host's verdict until the harness catalog has answered.
 * The caller does not ask while a pick is in flight: the controls present the
 * pick, the record waits for the write, and the two differing is the one
 * difference that means nothing is wrong.
 */
export function judgeWarningCause(input: {
  readonly stored: AutoJudgeSelection;
  readonly blocked: AutoJudgeBlocked | null;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  /** The stored provider's catalog, or `undefined` while it has not answered. */
  readonly offeredModels: ReadonlyArray<GuiAgentModelOption> | undefined;
  /**
   * Commit ids the stored provider currently offers, or `undefined` while
   * `providers.list` has not answered. Commit ids, not wire rows: the stored
   * record speaks the composer's vocabulary, where ambient is `null`.
   */
  readonly offeredProfileIds: ReadonlyArray<string | null> | undefined;
}): JudgeWarningCause | null {
  const { stored } = input;
  if (input.blocked !== null) return { kind: input.blocked.reason };
  if (input.harnesses === undefined) return null;
  const row = input.harnesses.find(
    (candidate) => candidate.id === stored.harnessId,
  );
  if (row === undefined) return { kind: "unrecognized" };
  const blocker = judgeProviderBlocker(row);
  if (blocker !== null) return { kind: "provider", blocker };
  if (judgeModelUnavailable(stored.model, input.offeredModels)) {
    return { kind: "model" };
  }
  if (judgeProfileUnavailable(stored.profileId, input.offeredProfileIds)) {
    return { kind: "profile" };
  }
  return null;
}

/**
 * The line under a provider chosen whose catalog answered with nothing to
 * judge on: the pick stays on screen, uncommitted, and this says why.
 */
export function judgeNoModelsLine(providerLabel: string): string {
  return `${providerLabel} offers no models on this machine. Pick another provider.`;
}

/**
 * The line under a provider whose catalog read failed. Reopening Settings
 * remounts the tab, and a query in error refetches on mount.
 */
export function judgeModelsFailedLine(providerLabel: string): string {
  return `Couldn't load ${providerLabel}'s models. Reopen Settings to try again, or pick another provider.`;
}

/**
 * Whether the judge's STORED model is gone from what its harness offers.
 *
 * Shared by the Judge tab's warning line and the composer's Auto row, which
 * must reach the same verdict: the composer stops claiming a provider account
 * will be charged exactly when Settings says the judge cannot run.
 *
 * It asks {@link resolveModelBySlug} rather than comparing slugs, because a
 * stored slug is also matched by a row whose `metadata.resolvedModel` equals
 * it - an entitlement-decorated catalog (`opus[1m]` listed where
 * `claude-opus-5` was persisted) still runs the stored judge. Exact equality
 * is a strictly narrower question, and answering it here once called a
 * runnable judge gone.
 *
 * `models` must be one harness's catalog, which is what `agent.gui.listModels`
 * returns; {@link resolveModelBySlug} is only unique within a harness.
 *
 * Both "cannot say" values are `false`: `""` names no model, and `undefined`
 * offers is a catalog that has not answered - reading either as "the model is
 * gone" would flash the warning, and suppress the disclosure, on every cold
 * load.
 */
export function judgeModelUnavailable(
  storedModelSlug: string,
  offeredModels: ReadonlyArray<GuiAgentModelOption> | undefined,
): boolean {
  if (storedModelSlug.length === 0) return false;
  if (offeredModels === undefined) return false;
  return !modelMatchIsCovered(
    resolveModelBySlug(offeredModels, storedModelSlug),
  );
}

/**
 * Whether the judge's STORED profile is gone from what its provider offers.
 *
 * Two surfaces ask it and must not answer differently, as with the model:
 * Settings warns about the record, and the composer's Auto row stops claiming
 * the provider account will be charged - a judge whose profile vanished does
 * not run, so every command escalates and no pocket is touched.
 *
 * Two "cannot say" values, both `false`. `null` is AMBIENT - the account the
 * CLI is already signed into, which has no row to delete and which every
 * provider has. `undefined` offers is the providers read not having answered.
 */
export function judgeProfileUnavailable(
  storedProfileId: string | null,
  offeredProfileIds: ReadonlyArray<string | null> | undefined,
): boolean {
  if (storedProfileId === null) return false;
  if (offeredProfileIds === undefined) return false;
  return !offeredProfileIds.includes(storedProfileId);
}

/**
 * The profile commit ids a harness's provider currently offers.
 *
 * `undefined` for every "cannot say" - the providers read has not answered, or
 * the harness maps to no provider - which is the value
 * {@link judgeProfileUnavailable} treats as unknown rather than as "every
 * stored profile is gone".
 */
export function offeredJudgeProfileIds(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: string,
): ReadonlyArray<string | null> | undefined {
  if (providers === undefined) return undefined;
  return providerForHarness(providers, harnessId)?.profiles.map(
    profileCommitId,
  );
}
