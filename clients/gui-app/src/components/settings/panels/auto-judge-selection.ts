/**
 * The host's stored judge selection, mapped to and from the shape the
 * composer's toolbar store speaks.
 *
 * Split out of `auto-judge-picker.tsx` because a module that exports a
 * component may export nothing else - fast refresh replaces the whole module,
 * so `react(only-export-components)` fails a build over a helper living beside
 * one. These are the pure half of that row and the half worth testing without
 * rendering a picker.
 */
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { GuiHarnessOption } from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import {
  modelMatchIsCovered,
  resolveModelBySlug,
} from "@traycer/protocol/host/agent/gui/model-slug-resolution";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import type {
  AutoJudgeEffective,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import {
  DEFAULT_PERMISSION,
  type HarnessModelSelection,
} from "@/components/home/data/landing-options";
import type { ComposerToolbarValues } from "@/stores/composer/composer-toolbar-store";

/**
 * The harness the judge runs on when nothing is stored. Traycer's own, whose
 * catalog model the SERVER flags (`autoJudgeDefault`). New hosts report its
 * resolved slug through `effective`; older hosts leave this seed unpinned.
 */
const DEFAULT_JUDGE_HARNESS_ID = "traycer";

/**
 * The values a picker with no stored selection starts from. `modelSlug: ""` is
 * the no-carry lever: the toolbar store resolves the harness's own default
 * model rather than pinning one this build guessed at.
 */
const UNSET_JUDGE_SELECTION: HarnessModelSelection = {
  harnessId: DEFAULT_JUDGE_HARNESS_ID,
  modelSlug: "",
  profileId: null,
};

export interface AutoJudgeSeed {
  readonly values: ComposerToolbarValues;
  readonly seedKey: string;
  /**
   * A stored harness id this build has no adapter for - a newer host, an older
   * app. The protocol keeps `harnessId` a checked string precisely so this
   * decodes instead of failing the whole selection, and the row says so rather
   * than presenting some other provider as the judge.
   */
  readonly unrecognizedHarnessId: string | null;
  /**
   * The display label of the stored harness, when the catalog knows it. Used
   * only by the "not available on this machine" line, so a user reads
   * "Claude Code" rather than the wire id.
   */
  readonly storedHarnessLabel: string | null;
}

/**
 * Maps the host's stored judge selection onto toolbar-store values.
 *
 * `permission`, `reasoning` and `serviceTier` are inert here and stay at their
 * neutral values: the judge record is `(harness, model, profile)` and the
 * judge request carries nothing else, so there is no axis for them to reach.
 * The picker hides both footers for the same reason (`withServiceTier` /
 * `withReasoning` off).
 *
 * The harness id is narrowed through the CATALOG rather than parsed: a row
 * whose `id` matches is itself the proof that this build knows the harness, and
 * it hands back a properly-typed id with no cast. While the catalog is still
 * loading nothing can be narrowed, so the seed key says so and the store
 * re-seeds (silently - `applySeed` never emits) once the rows arrive.
 */
export function autoJudgeSeed(
  selection: AutoJudgeSelection | null,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
  effective: AutoJudgeEffective | null | undefined,
): AutoJudgeSeed {
  // New hosts identify the default themselves. The empty-model seed is only
  // the compatibility fallback for a host that cannot report that fact.
  const resolved =
    selection ??
    (effective === null || effective === undefined
      ? null
      : {
          harnessId: effective.harnessId,
          model: effective.model,
          profileId: null,
        });
  const neutral = {
    permission: DEFAULT_PERMISSION,
    reasoning: "",
    serviceTier: "",
    // The judge runs no chat, so it carries no identity.
    identityId: null,
  } as const;
  if (resolved === null) {
    return {
      values: { ...neutral, selection: UNSET_JUDGE_SELECTION },
      seedKey: "unset",
      unrecognizedHarnessId: null,
      storedHarnessLabel: null,
    };
  }
  if (harnesses === undefined) {
    return {
      values: { ...neutral, selection: UNSET_JUDGE_SELECTION },
      seedKey: "loading",
      unrecognizedHarnessId: null,
      storedHarnessLabel: null,
    };
  }
  const row = harnesses.find((harness) => harness.id === resolved.harnessId);
  if (row === undefined) {
    return {
      values: { ...neutral, selection: UNSET_JUDGE_SELECTION },
      seedKey: `unrecognized:${resolved.harnessId}`,
      unrecognizedHarnessId: resolved.harnessId,
      storedHarnessLabel: null,
    };
  }
  return {
    values: {
      ...neutral,
      selection: {
        harnessId: row.id,
        modelSlug: resolved.model,
        profileId: resolved.profileId,
      },
    },
    seedKey: [row.id, resolved.model, resolved.profileId ?? ""].join("\u0000"),
    unrecognizedHarnessId: null,
    storedHarnessLabel: row.label,
  };
}

/**
 * The key `applySeed` is actually handed: the stored record's own key, plus a
 * counter the caller bumps to force a RE-seed of a record that did not change.
 *
 * `applySeed` early-returns on a matching key, by design - it is the guard that
 * stops a re-render from clobbering an in-progress edit. That guard is also
 * what strands the picker after a REFUSED write: the user's pick lives in the
 * store's `values`, the authoritative record in the cache never moved, so the
 * seed key never moves either and nothing puts the picker back. Rolling back is
 * therefore not "apply the cached seed again" - that is a no-op - it is "make
 * this a different seed", which is what the nonce does.
 *
 * `0` returns the base key unchanged so the store's initial `seedKey` (created
 * from `autoJudgeSeed(...).seedKey` before any failure exists) matches, and the
 * first successful render seeds nothing twice.
 */
export function autoJudgeSeedKeyForAttempt(
  seedKey: string,
  resetNonce: number,
): string {
  return resetNonce === 0 ? seedKey : `${seedKey}|reset:${resetNonce}`;
}

/**
 * What is WRONG with the stored judge record, as three settled facts.
 *
 * Pure and here rather than inline in the picker for two reasons. It is the
 * half worth testing without rendering a picker (the same argument that put
 * `autoJudgeSeed` in this module), and inline it pushed `AutoJudgePicker` past
 * the complexity ceiling gui-app lints at - which is the honest signal that six
 * interdependent booleans in a component body are one decision wearing a
 * disguise.
 *
 * Every field answers "only when we actually know". The toolbar store PRESENTS
 * a substitute whenever the stored harness or model is not on offer, and never
 * emits it - a display fallback, not a choice - so a difference between
 * presented and stored is the detector. But it is only evidence once the
 * catalog it was resolved against has ARRIVED: while the rows are loading the
 * store passes the selection through untouched, and `modelsLoaded` is the
 * store's own explicit flag for that (never `models.length`, which cannot tell
 * "no models" from "not yet").
 */
export interface AutoJudgeRecordHealth {
  /** The stored harness is not on this machine; the host will escalate. */
  readonly storedHarnessUnavailable: boolean;
  /** The harness is fine but the stored MODEL has left the catalog. */
  readonly storedModelUnavailable: boolean;
  /**
   * The harness is fine but the stored PROFILE is gone from it.
   *
   * The third member of the record, and the one whose display fallback is the
   * quietest: `resolveActiveProfileForHarness` presents the harness's FIRST
   * profile when neither the browsed nor the stored id matches, and under two
   * profiles it presents no strip at all - so a deleted profile leaves a picker
   * that looks entirely settled while the host still holds the removed id and
   * fails the judge call on it.
   */
  readonly storedProfileUnavailable: boolean;
  /**
   * Nothing will call a judge, so no billing line may be shown beside it. Two
   * adjacent status lines - "no judge will run" and "this will be charged to
   * your provider account" - contradict each other, and the contradiction is
   * worse than either line alone.
   */
  readonly noJudgeWillRun: boolean;
}

export function autoJudgeRecordHealth(input: {
  readonly hasStoredSelection: boolean;
  readonly unrecognizedHarnessId: string | null;
  readonly isBlocked: boolean;
  /**
   * Whether a write is in flight for this record.
   *
   * The detector below is "presented differs from stored", which reads a
   * DISPLAY FALLBACK - and during a write it reads something else entirely.
   * The store adopts the user's pick the moment they click, while the stored
   * prop waits for the response, so an ordinary valid pick makes the two differ
   * for the width of the round trip. Without this, choosing a perfectly
   * available model announced that the machine "no longer offers" it and
   * suppressed the billing line while the save was still in the air.
   */
  readonly saving: boolean;
  readonly storedHarnessId: string;
  readonly presentedHarnessId: string;
  readonly storedModelSlug: string;
  readonly presentedModelSlug: string;
  readonly modelsLoaded: boolean;
  /** `null` is the ambient account, which no provider can delete. */
  readonly storedProfileId: string | null;
  /**
   * Commit ids the stored harness's provider currently offers, or `undefined`
   * while `providers.list` has not answered.
   *
   * The COMMIT ids (`profileCommitId`), not the wire rows: the stored record
   * speaks the same vocabulary the composer does, where ambient is `null` and
   * never the `"ambient"` wire sentinel. Passed as ids rather than as profile
   * objects because a commit id is the whole question here - membership in a
   * set, with no second matching pass to run.
   *
   * That is what separates it from {@link judgeModelUnavailable}, which USED to
   * take slugs on the same reasoning and was wrong to: a model slug can also be
   * matched by a row's `metadata.resolvedModel`, so the ids alone were not
   * enough evidence and it now takes rows. Profiles have no such alias.
   */
  readonly offeredProfileIds: ReadonlyArray<string | null> | undefined;
}): AutoJudgeRecordHealth {
  // A record this build cannot read at all is `unrecognizedHarnessId`'s line to
  // report; every reroute below would be a consequence of it, not a finding.
  // A record mid-WRITE is not a record to diagnose. Every flag below compares
  // the presented tuple against the stored one, and during a save those differ
  // because the user just chose - which is the one difference that means
  // nothing is wrong. The write settles quickly and either updates `stored`
  // (success, through the write-through) or rolls the picker back (refusal,
  // through `resetNonce`), so nothing is withheld for long.
  const readable =
    input.hasStoredSelection &&
    input.unrecognizedHarnessId === null &&
    !input.saving;
  const storedHarnessUnavailable =
    readable && input.presentedHarnessId !== input.storedHarnessId;
  const storedModelUnavailable =
    readable &&
    !storedHarnessUnavailable &&
    input.modelsLoaded &&
    // `""` is the no-carry seed for an unset record - the store is SUPPOSED to
    // resolve it to the harness default, so a difference there is the feature.
    input.storedModelSlug.length > 0 &&
    input.presentedModelSlug !== input.storedModelSlug;
  // Gated behind the harness for the same reason the model is: a vanished
  // harness is the finding, and its profile list going with it is a
  // consequence, not a second one to report.
  //
  // Ambient (`null`) is excluded outright - it is the account the CLI is
  // already signed into, it has no row to delete, and every provider has one.
  const storedProfileUnavailable =
    readable &&
    !storedHarnessUnavailable &&
    judgeProfileUnavailable(input.storedProfileId, input.offeredProfileIds);
  return {
    storedHarnessUnavailable,
    storedModelUnavailable,
    storedProfileUnavailable,
    // The missing-MODEL case belongs here too, and its absence was a miss in
    // the same change that introduced it: the row already tells the user "Auto
    // mode will ask you instead of judging" for a vanished model, which IS this
    // flag's meaning, while the self-billing line beside it went on claiming
    // their provider account would be charged. Same contradiction the blocked
    // and missing-harness cases are here to prevent.
    noJudgeWillRun:
      input.isBlocked ||
      storedHarnessUnavailable ||
      storedModelUnavailable ||
      storedProfileUnavailable,
  };
}

/**
 * Whether the judge's STORED profile is gone from what its provider offers.
 *
 * The bare rule, with no surface's framing around it, because two surfaces ask
 * it and they must not answer differently: Settings renders it as a warning on
 * the record, and the composer's Auto row has to stop claiming the provider
 * account will be charged - a judge whose profile vanished does not run, so
 * every command escalates to the human and no pocket is touched.
 *
 * Two "cannot say" values, both `false`. `null` is AMBIENT - the account the
 * CLI is already signed into, which has no row to delete and which every
 * provider has. `undefined` offers is the providers read not having answered;
 * reading that as "the stored profile is gone" would flash the warning, and
 * suppress the billing line, on every cold load.
 */
/**
 * Whether the judge's STORED model is gone from what its harness offers.
 *
 * The composer's half of what Settings detects as `storedModelUnavailable`, and
 * deliberately a DIFFERENT mechanism for the same fact - which is worth stating
 * rather than hiding, because "share one read" would be the wrong instinct
 * here. The picker asks its store, which resolves a substitute whenever the
 * stored model is not on offer, so presented-vs-stored IS the detector there.
 * The composer has no picker and no substitute; it has the raw catalog, so it
 * asks the catalog directly. Two questions, one fact, and neither surface can
 * answer the other's.
 *
 * **Different mechanisms, but they must reach the same verdict, and they did
 * not.** This took the catalog's SLUGS and compared with `includes()`, while
 * the picker's store resolves through {@link resolveModelBySlug} - a two-pass
 * match that also accepts a row whose `metadata.resolvedModel` equals the
 * stored slug, and then HOLDS the stored slug rather than rewriting it (see
 * `resolveModelSlug`). So an entitlement-decorated catalog (`opus[1m]` listed
 * where `claude-opus-5` was persisted) left Settings correctly reporting a
 * runnable judge while this predicate called it gone and suppressed the charge
 * disclosure for a judge that routes fine. Exact equality is not a second
 * spelling of coverage - it is a strictly narrower question - so this now asks
 * the SAME resolver, and takes catalog ROWS because slugs alone cannot answer
 * it.
 *
 * `models` must be one harness's catalog, which is what
 * `agent.gui.listModels` returns; {@link resolveModelBySlug} is only unique
 * within a harness.
 *
 * Both "cannot say" values are `false`, matching {@link judgeProfileUnavailable}:
 * `""` is the no-carry seed for an unset record (the store is SUPPOSED to
 * resolve it to the harness default), and `undefined` offers is a catalog that
 * has not answered - reading either as "the model is gone" would suppress the
 * disclosure on every cold load. `""` is also what `resolveModelBySlug` answers
 * `none` for, so it is checked here rather than relied on there.
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
 * `undefined` for every "cannot say" - the providers read has not answered, the
 * harness maps to no provider, or the catalog has no row for it - which is the
 * value {@link autoJudgeRecordHealth} treats as unknown rather than as "every
 * stored profile is gone".
 *
 * Pure and here rather than in the picker for this module's usual reason: it is
 * the half worth testing without rendering one, and the component it serves is
 * already at the complexity ceiling gui-app lints at.
 */
export function offeredJudgeProfileIds(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  harnessId: string,
): ReadonlyArray<string | null> | undefined {
  if (providers === undefined) return undefined;
  // Projected provider -> harness, not harness -> provider, and the direction
  // is load-bearing. `guiHarnessIdToProviderId` takes a `GuiHarnessId`, while
  // what arrives here is `HarnessModelSelection.harnessId` - declared
  // `ProviderId` and carrying a `GuiHarnessId` at runtime (`autoJudgeSeed`
  // stores `row.id`). The two unions differ in exactly one member
  // (`claude-code` / `claude`), so neither is assignable to the other and
  // calling that way round is a type error `vitest` cannot see. Reading each
  // provider's OWN id through the total `providerIdToGuiHarnessId` needs no
  // narrowing at all, and it is the same projection `HarnessModelPicker`
  // already keys its profile map by.
  const provider = providers.find(
    (candidate) => providerIdToGuiHarnessId(candidate.providerId) === harnessId,
  );
  if (provider === undefined) return undefined;
  return provider.profiles.map(profileCommitId);
}

/**
 * The judge selection a settings emit carries. `ChatRunSettings` is the shape
 * the toolbar store speaks; only three of its fields are a fact about the
 * judge.
 */
export function autoJudgeSelectionFrom(
  settings: ChatRunSettings,
): AutoJudgeSelection {
  return {
    harnessId: settings.harnessId,
    model: settings.model,
    profileId: settings.profileId,
  };
}
