import {
  nonDefaultServiceTiersForModel,
  normalizeServiceTierForModel,
} from "@/components/home/data/landing-options";
import type { ServiceTierFooterConfig } from "@/components/home/pickers/harness-model-picker-footers";

/** Step through Standard and the selected model's advertised tiers. */
export function stepServiceTier(
  config: ServiceTierFooterConfig | null,
): boolean {
  if (config === null) return false;
  const options = nonDefaultServiceTiersForModel(config.selectedModel);
  if (options.length === 0) return false;
  const current = normalizeServiceTierForModel(
    config.value,
    config.selectedModel,
  );
  const index = options.findIndex((option) => option.id === current);
  config.onChange(
    index === options.length - 1 ? "" : (options[index + 1]?.id ?? ""),
  );
  return true;
}
