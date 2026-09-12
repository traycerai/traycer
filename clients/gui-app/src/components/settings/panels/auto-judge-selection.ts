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
import type { AutoJudgeSelection } from "@traycer/protocol/host/auto-mode/contracts";
import {
  DEFAULT_PERMISSION,
  type HarnessModelSelection,
} from "@/components/home/data/landing-options";
import type { ComposerToolbarValues } from "@/stores/composer/composer-toolbar-store";

/**
 * The harness the judge runs on when nothing is stored. Traycer's own, whose
 * catalog model the SERVER flags (`autoJudgeDefault`) - which is why the unset
 * state names no model here: the flag never reaches the client, deliberately,
 * so the server can move the default judge without a host or app release.
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
): AutoJudgeSeed {
  const neutral = {
    permission: DEFAULT_PERMISSION,
    reasoning: "",
    serviceTier: "",
  } as const;
  if (selection === null) {
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
  const row = harnesses.find((harness) => harness.id === selection.harnessId);
  if (row === undefined) {
    return {
      values: { ...neutral, selection: UNSET_JUDGE_SELECTION },
      seedKey: `unrecognized:${selection.harnessId}`,
      unrecognizedHarnessId: selection.harnessId,
      storedHarnessLabel: null,
    };
  }
  return {
    values: {
      ...neutral,
      selection: {
        harnessId: row.id,
        modelSlug: selection.model,
        profileId: selection.profileId,
      },
    },
    seedKey: [row.id, selection.model, selection.profileId ?? ""].join(
      "\u0000",
    ),
    unrecognizedHarnessId: null,
    storedHarnessLabel: row.label,
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
