/**
 * Docs: see ../../SETTINGS.md (Permissions ▸ Judge).
 * Update that file whenever this settings surface changes.
 *
 * The pure half of the Judge tab's two tiles: which row of the tile-state
 * table the card is in, what the second tile's face shows, and what the
 * judge's toolbar store is seeded with. Kept apart from the tab because a
 * module that exports a component may export nothing else (fast refresh), and
 * because these are the decisions worth testing without rendering a picker.
 */
import {
  guiHarnessIdSchema,
  type GuiHarnessOption,
} from "@traycer/protocol/host/index";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type {
  AutoJudgeEffective,
  AutoJudgeGetResponse,
  AutoJudgeSelection,
} from "@traycer/protocol/host/auto-mode/contracts";
import type {
  ProviderCliState,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { HarnessModelSelection } from "@/components/home/data/landing-options";
import { profileCommitId } from "@/components/providers/provider-profile-model";
import {
  judgeProviderBlocker,
  judgeWarningCause,
  offeredJudgeProfileIds,
  providerForHarness,
  type JudgeWarningCause,
} from "@/components/settings/panels/auto-judge-selection";
import {
  providerIdToGuiHarnessId,
  sortGuiHarnessesByProviderOrder,
} from "@/lib/provider-ordering";

/**
 * A pick the tiles present before the host has stored it. `id` orders picks,
 * so only the LATEST one's settlement clears it: an older write landing must
 * not snap the tiles back to a superseded choice. `selection: null` is a
 * switch to Automatic.
 */
export interface JudgeDraft {
  readonly id: number;
  readonly selection: AutoJudgeSelection | null;
}

/**
 * The rows of the tile-state table.
 *
 * - `loading`: the record has not answered. Both tiles are inert, no face.
 * - `picked`: a model is chosen (stored, or the latest pick on screen).
 * - `last-runs`: Automatic, and the last pick can run here. The second tile
 *   shows it dimmed and inert; choosing the tile brings it back.
 * - `last-broken`: Automatic, and the last pick cannot run here. The face
 *   names why; choosing the tile opens the picker instead of saving it.
 * - `no-last`: Automatic, and the machine has no last pick (or its host is too
 *   old to keep one). The face says "Choose a model"; choosing the tile opens
 *   the picker.
 */
export type JudgeTileRow =
  | "loading"
  | "picked"
  | "last-runs"
  | "last-broken"
  | "no-last";

export interface JudgeTileState {
  readonly row: JudgeTileRow;
  /** The host cannot store a selection: every face is inert, at full opacity. */
  readonly readOnly: boolean;
  /**
   * What the second tile's face shows: the pick in `picked`, the last pick in
   * the two `last-*` rows, `null` otherwise.
   */
  readonly shown: AutoJudgeSelection | null;
  /** Why the last pick cannot run, in `last-broken`; `null` otherwise. */
  readonly lastCause: JudgeWarningCause | null;
}

/**
 * The last pick the second tile keeps on show while Automatic is on.
 *
 * While the latest pick is a switch TO Automatic, the record's own selection
 * is the pick being cleared: the host moves it into `lastSelection`, but the
 * cached `lastSelection` is the one from before the save until the echo lands,
 * and showing it would flash the previous last pick (or "Choose a model") for
 * the whole round trip. Otherwise the record's `lastSelection`, where absent (a
 * host older than `autoJudge.get@1.2`) and `null` both mean none.
 */
export function lastJudgePick(
  record: AutoJudgeGetResponse,
  draft: JudgeDraft | null,
): AutoJudgeSelection | null {
  if (draft !== null && draft.selection === null && record.selection !== null) {
    return record.selection;
  }
  return record.lastSelection ?? null;
}

/** The selection the tiles present: the latest pick, else the record's. */
export function displayedJudgePick(
  record: AutoJudgeGetResponse | undefined,
  draft: JudgeDraft | null,
): AutoJudgeSelection | null {
  if (draft !== null) return draft.selection;
  return record?.selection ?? null;
}

/**
 * The pick the second tile's face would show, before its catalog is known:
 * what the tab fetches models for, so the face can be labelled and the last
 * pick judged.
 */
export function shownJudgePick(
  record: AutoJudgeGetResponse | undefined,
  draft: JudgeDraft | null,
): AutoJudgeSelection | null {
  if (record === undefined) return null;
  return displayedJudgePick(record, draft) ?? lastJudgePick(record, draft);
}

/**
 * Which row of the tile-state table the card is in.
 *
 * `runnable(last)` is {@link judgeWarningCause} over the last pick with
 * `blocked: null`: it sees provider state, the harness roster, the model
 * offered and the account offered. It cannot see the host's own
 * `unsupported-harness` verdict, which the host computes only for the STORED
 * selection, so a last pick on a harness this host has no judge for reads as
 * runnable; choosing it saves it, and the echo's amber line corrects that in
 * one round trip.
 */
export function judgeTileState(input: {
  readonly record: AutoJudgeGetResponse | undefined;
  readonly draft: JudgeDraft | null;
  readonly canWrite: boolean;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
  readonly providers: ReadonlyArray<ProviderCliState> | undefined;
  /** The shown pick's catalog (`shownJudgePick`), `undefined` until it answers. */
  readonly shownModels: ReadonlyArray<GuiAgentModelOption> | undefined;
}): JudgeTileState {
  const { record, draft } = input;
  const readOnly = !input.canWrite;
  if (record === undefined) {
    return { row: "loading", readOnly, shown: null, lastCause: null };
  }
  const displayed = displayedJudgePick(record, draft);
  if (displayed !== null) {
    return { row: "picked", readOnly, shown: displayed, lastCause: null };
  }
  const last = lastJudgePick(record, draft);
  if (last === null) {
    return { row: "no-last", readOnly, shown: null, lastCause: null };
  }
  const cause = judgeWarningCause({
    stored: last,
    blocked: null,
    harnesses: input.harnesses,
    offeredModels: input.shownModels,
    offeredProfileIds: offeredJudgeProfileIds(input.providers, last.harnessId),
  });
  return {
    row: cause === null ? "last-runs" : "last-broken",
    readOnly,
    shown: last,
    lastCause: cause,
  };
}

/**
 * The picker's own `disabled`. It can never open while the tiles are loading,
 * while the host cannot store a pick, or while the last pick runs (the tile
 * restores it without one). The two rows that open the picker keep it
 * enabled: a disabled picker force-closes.
 */
export function judgePickerDisabled(state: JudgeTileState): boolean {
  return state.row === "loading" || state.readOnly || state.row === "last-runs";
}

/**
 * The face is inert - `aria-disabled`, out of the Tab order and transparent to
 * the pointer, so a click on it lands on the tile - exactly where the picker
 * cannot open. Never natively `disabled`: a disabled button eats the click.
 */
export function judgeFaceInert(state: JudgeTileState): boolean {
  return judgePickerDisabled(state);
}

/** The face is dimmed while Automatic is on, except read-only. */
export function judgeFaceDimmed(state: JudgeTileState): boolean {
  if (state.readOnly) return false;
  return (
    state.row === "last-runs" ||
    state.row === "last-broken" ||
    state.row === "no-last"
  );
}

/** Choosing the second tile opens the picker rather than saving anything. */
export function judgeTileOpensPicker(state: JudgeTileState): boolean {
  if (state.readOnly) return false;
  return state.row === "last-broken" || state.row === "no-last";
}

const TRAYCER_HARNESS_ID = providerIdToGuiHarnessId("traycer");

/** A stored selection in the toolbar store's vocabulary, or `null` for a
 *  harness id this build does not know. */
export function judgeStoreSelection(
  selection: AutoJudgeSelection,
): HarnessModelSelection | null {
  const parsed = guiHarnessIdSchema.safeParse(selection.harnessId);
  if (!parsed.success) return null;
  return {
    harnessId: parsed.data,
    modelSlug: selection.model,
    profileId: selection.profileId,
  };
}

/**
 * What the judge's toolbar store starts from when there is no pick to show:
 * Traycer on the model Automatic resolves to when the host names one, else
 * the first provider that can run here with `""`, which the store resolves to
 * that provider's catalog default once it loads. Only where the picker opens
 * depends on it; nothing is saved until something in it is clicked.
 */
export function judgeUnpickedSeed(
  effective: AutoJudgeEffective | null | undefined,
  harnesses: ReadonlyArray<GuiHarnessOption> | undefined,
): HarnessModelSelection {
  if (effective !== null && effective !== undefined) {
    if (effective.source === "default") {
      const parsed = guiHarnessIdSchema.safeParse(effective.harnessId);
      if (parsed.success) {
        return {
          harnessId: parsed.data,
          modelSlug: effective.model,
          profileId: null,
        };
      }
    }
  }
  const runnable =
    harnesses === undefined
      ? undefined
      : sortGuiHarnessesByProviderOrder(harnesses).find(
          (row) => row.available && judgeProviderBlocker(row) === null,
        );
  return {
    harnessId: runnable?.id ?? TRAYCER_HARNESS_ID,
    modelSlug: "",
    profileId: null,
  };
}

/** The toolbar store's seed selection for a tile state. */
export function judgeSeedSelection(input: {
  readonly state: JudgeTileState;
  readonly effective: AutoJudgeEffective | null | undefined;
  readonly harnesses: ReadonlyArray<GuiHarnessOption> | undefined;
}): HarnessModelSelection {
  const { shown } = input.state;
  const fromShown = shown === null ? null : judgeStoreSelection(shown);
  return fromShown ?? judgeUnpickedSeed(input.effective, input.harnesses);
}

/**
 * The account a pick names, when its provider has more than one on this
 * machine - the composer's chip names it under the same rule. `null` for one
 * account or none, or an account that is gone (the warning line says so).
 */
export function judgePickAccount(
  providers: ReadonlyArray<ProviderCliState> | undefined,
  selection: AutoJudgeSelection,
): ProviderProfile | null {
  const profiles = providerForHarness(providers, selection.harnessId)?.profiles;
  if (profiles === undefined || profiles.length < 2) return null;
  return (
    profiles.find(
      (profile) => profileCommitId(profile) === selection.profileId,
    ) ?? null
  );
}

/**
 * The few words the dimmed face adds after a last pick that cannot run, so
 * the tile says why before it is clicked ("Grok 4.7 Fast · Signed out").
 */
export function judgeCauseShortLabel(cause: JudgeWarningCause): string {
  switch (cause.kind) {
    case "provider":
      return cause.blocker;
    case "provider-disabled":
      return "Turned off";
    case "unsupported-harness":
      return "Can't judge here";
    case "unrecognized":
      return "Unknown provider";
    case "model":
      return "No longer offered";
    case "profile":
      return "Account removed";
  }
}
