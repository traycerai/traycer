import { findUpgradeServiceTierForModel } from "@/components/home/data/landing-options";
import type { ServiceTierFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";

/** Shared by the Fast button and its leader shortcut. */
export function toggleServiceTier(
  config: ServiceTierFooterConfig | null,
): boolean {
  if (config === null) return false;
  const upgrade = findUpgradeServiceTierForModel(config.selectedModel);
  if (upgrade === null) return false;
  config.onChange(config.value === upgrade.id ? "" : upgrade.id);
  return true;
}
