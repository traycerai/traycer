import {
  findReasoningLabel,
  findUpgradeServiceTierForModel,
  findModelLabel,
  type HarnessModelSelection,
  type ModelOption,
} from "@/components/home/data/landing-options";
import type {
  ReasoningFooterConfig,
  ServiceTierFooterConfig,
} from "@/components/home/pickers/harness-model-picker-footers";

interface HarnessModelPickerPresentationInput {
  readonly selection: HarnessModelSelection;
  readonly models: ReadonlyArray<ModelOption>;
  readonly reasoningFooter: ReasoningFooterConfig | null;
  readonly serviceTierFooter: ServiceTierFooterConfig | null;
  readonly harnessesPending: boolean;
  readonly modelsPending: boolean;
  readonly selectedHarnessAvailable: boolean;
}

export interface HarnessModelPickerPresentation {
  readonly label: string;
  readonly reasoningLabel: string | null;
  readonly activeServiceTierLabel: string | null;
  readonly serviceTierActive: boolean;
  readonly isLoading: boolean;
}

export function deriveHarnessModelPickerPresentation(
  input: HarnessModelPickerPresentationInput,
): HarnessModelPickerPresentation {
  const {
    selection,
    models,
    reasoningFooter,
    serviceTierFooter,
    harnessesPending,
    modelsPending,
    selectedHarnessAvailable,
  } = input;

  const label = findModelLabel(models, selection);
  const reasoningLabel =
    reasoningFooter !== null && reasoningFooter.options.length > 0
      ? findReasoningLabel(reasoningFooter.value, reasoningFooter.options)
      : null;
  const upgradeServiceTier =
    serviceTierFooter === null
      ? null
      : findUpgradeServiceTierForModel(serviceTierFooter.selectedModel);
  const serviceTierActive =
    serviceTierFooter !== null &&
    upgradeServiceTier !== null &&
    serviceTierFooter.value === upgradeServiceTier.id;
  const activeServiceTierLabel =
    upgradeServiceTier === null || !serviceTierActive
      ? null
      : upgradeServiceTier.label;
  const isLoading =
    harnessesPending || (selectedHarnessAvailable && modelsPending);

  return {
    label,
    reasoningLabel,
    activeServiceTierLabel,
    serviceTierActive,
    isLoading,
  };
}
