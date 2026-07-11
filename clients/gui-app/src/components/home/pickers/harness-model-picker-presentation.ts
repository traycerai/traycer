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
  readonly reasoningFooter: ReasoningFooterConfig | null;
  readonly serviceTierFooter: ServiceTierFooterConfig | null;
  readonly harnessesPending: boolean;
  readonly modelsPending: boolean;
  readonly selectedHarnessAvailable: boolean;
  /** The SELECTED (committed) harness's profiles - drives the composer
   *  chip's send-identity badge, distinct from the panel's browsed
   *  provider. */
  readonly selectedHarnessProfiles: ReadonlyArray<ProviderProfile>;
}

export interface HarnessModelPickerPresentation {
  readonly label: string;
  readonly reasoningLabel: string | null;
  readonly activeServiceTierLabel: string | null;
  readonly serviceTierActive: boolean;
  readonly isLoading: boolean;
  readonly profileLabel: string | null;
  readonly profileAccentDot: ProfileAccentDotInput | null;
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
    selectedHarnessProfiles,
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
    activeServiceTierLabel,
    serviceTierActive,
    isLoading,
    profileLabel,
    profileAccentDot,
  };
}
