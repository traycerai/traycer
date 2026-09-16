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
  readonly storedHarnessId: string;
  readonly presentedHarnessId: string;
  readonly storedModelSlug: string;
  readonly presentedModelSlug: string;
  readonly modelsLoaded: boolean;
}): AutoJudgeRecordHealth {
  // A record this build cannot read at all is `unrecognizedHarnessId`'s line to
  // report; every reroute below would be a consequence of it, not a finding.
  const readable =
    input.hasStoredSelection && input.unrecognizedHarnessId === null;
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
  return {
    storedHarnessUnavailable,
    storedModelUnavailable,
    // The missing-MODEL case belongs here too, and its absence was a miss in
    // the same change that introduced it: the row already tells the user "Auto
    // mode will ask you instead of judging" for a vanished model, which IS this
    // flag's meaning, while the self-billing line beside it went on claiming
    // their provider account would be charged. Same contradiction the blocked
    // and missing-harness cases are here to prevent.
    noJudgeWillRun:
      input.isBlocked || storedHarnessUnavailable || storedModelUnavailable,
  };
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
