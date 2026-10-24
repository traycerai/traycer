import {
  findReasoningLabel,
  selectedServiceTierOption,
  findModelLabel,
  type HarnessModelSelection,
  type ModelOption,
} from "@/components/home/data/landing-options";
import type {
  ReasoningFooterConfig,
  ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";
import {
  maxModeListedFor,
  type MaxModeContext,
} from "@/components/home/data/model-max-mode";
import {
  profileAccentDotInput,
  profileCommitId,
  profileDisplayLabel,
  type ProfileAccentDotInput,
} from "@/components/providers/provider-profile-model";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";

interface HarnessModelPickerPresentationInput {
  readonly selection: HarnessModelSelection;
  readonly models: ReadonlyArray<ModelOption>;
  readonly selectedModel?: ModelOption | null;
  readonly reasoningFooter: ReasoningFooterConfig | null;
  readonly serviceTierFooter: ServiceTierFooterConfig | null;
  readonly maxModeContext?: MaxModeContext;
  readonly harnessesPending: boolean;
  readonly modelsPending: boolean;
  readonly selectedHarnessAvailable: boolean;
  /** The SELECTED (committed) harness's profiles - drives the composer
   *  chip's send-identity badge, distinct from the panel's browsed
   *  provider. */
  readonly selectedHarnessProfiles: ReadonlyArray<ProviderProfile>;
}

/**
 * Where the current thinking level sits on the selected model's LADDER, in the
 * order the host catalog lists it. `index` is 0-based and `null` when the
 * current value is not on the ladder - a no-thinking level, or a level
 * remembered from another model before normalization catches up - so a glyph
 * drawn from it shows every bar empty rather than a position it cannot know.
 */
export interface ReasoningStep {
  readonly index: number | null;
  readonly count: number;
}

/**
 * Levels that mean "do not think", which are an OFF state rather than the
 * bottom rung: counting them would make a model's lowest real effort read as
 * `2 of 7`, and selecting one would light a bar for thinking that is not
 * happening. The set is small and closed because the ids are a harness
 * convention, not an enum - amp advertises its ladder without a `none` at all,
 * while pi ships `off` alongside six graded levels.
 */
const ZERO_EFFORT_LEVEL_IDS: ReadonlySet<string> = new Set(["off", "none"]);

export interface HarnessModelPickerPresentation {
  readonly label: string;
  readonly reasoningLabel: string | null;
  /** `null` when the model has no ladder to draw: it exposes no levels, or
   *  only no-thinking ones. */
  readonly reasoningStep: ReasoningStep | null;
  readonly activeServiceTierLabel: string | null;
  readonly serviceTierActive: boolean;
  readonly maxModeRequired: boolean;
  readonly isLoading: boolean;
  readonly profileLabel: string | null;
  readonly profileAccentDot: ProfileAccentDotInput | null;
}

function maxModeRequiredForSelection(input: {
  readonly selectedModel: ModelOption | null | undefined;
  readonly models: ReadonlyArray<ModelOption>;
  readonly selection: HarnessModelSelection;
  readonly context: MaxModeContext | undefined;
}): boolean {
  const model =
    input.selectedModel ??
    input.models.find(
      (row) =>
        row.harnessId === input.selection.harnessId &&
        row.slug === input.selection.modelSlug,
    ) ??
    null;
  return maxModeListedFor(model, input.context ?? { kind: "none" });
}

export function deriveHarnessModelPickerPresentation(
  input: HarnessModelPickerPresentationInput,
): HarnessModelPickerPresentation {
  const {
    selection,
    models,
    selectedModel,
    reasoningFooter,
    serviceTierFooter,
    maxModeContext,
    harnessesPending,
    modelsPending,
    selectedHarnessAvailable,
    selectedHarnessProfiles,
  } = input;

  const label = findModelLabel(models, selection);
  const reasoningLabel =
    reasoningFooter !== null && reasoningFooter.options.length > 0
      ? findReasoningLabel(reasoningFooter.value, reasoningFooter.options)
      : null;
  const reasoningStep = deriveReasoningStep(reasoningFooter);
  const selectedServiceTier =
    serviceTierFooter === null
      ? null
      : selectedServiceTierOption(
          serviceTierFooter.value,
          serviceTierFooter.selectedModel,
        );
  const serviceTierActive = selectedServiceTier !== null;
  const activeServiceTierLabel = selectedServiceTier?.label ?? null;
  const maxModeRequired = maxModeRequiredForSelection({
    selectedModel,
    models,
    selection,
    context: maxModeContext,
  });
  const isLoading =
    harnessesPending || (selectedHarnessAvailable && modelsPending);
  const hasMultipleProfiles = selectedHarnessProfiles.length >= 2;
  // The profile a send will actually burn: the committed selection's profile,
  // resolved only once the provider crosses the 2-profile progressive-
  // disclosure gate. A stale/removed profileId that no longer matches any
  // known profile silently omits the badge rather than guessing.
  const activeProfile = hasMultipleProfiles
    ? (selectedHarnessProfiles.find(
        (profile) => profileCommitId(profile) === selection.profileId,
      ) ?? null)
    : null;
  const profileLabel =
    activeProfile === null ? null : profileDisplayLabel(activeProfile);
  const profileAccentDot: ProfileAccentDotInput | null =
    activeProfile === null ? null : profileAccentDotInput(activeProfile);

  return {
    label,
    reasoningLabel,
    reasoningStep,
    activeServiceTierLabel,
    serviceTierActive,
    maxModeRequired,
    isLoading,
    profileLabel,
    profileAccentDot,
  };
}

/** `3 of 4` for the glyph's name and the tooltip; `null` when the position
 *  is unknown, so neither claims one. */
export function formatReasoningPosition(step: ReasoningStep): string | null {
  if (step.index === null) return null;
  return `${step.index + 1} of ${step.count}`;
}

function deriveReasoningStep(
  reasoningFooter: ReasoningFooterConfig | null,
): ReasoningStep | null {
  if (reasoningFooter === null) return null;
  const ladder = reasoningFooter.options.filter(
    (option) => !ZERO_EFFORT_LEVEL_IDS.has(option.id),
  );
  if (ladder.length === 0) return null;
  const index = ladder.findIndex(
    (option) => option.id === reasoningFooter.value,
  );
  return { index: index === -1 ? null : index, count: ladder.length };
}
