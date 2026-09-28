import type { SegmentOption } from "@/components/layout-editor/regions/region-grammar";

/**
 * One provider row's disclosure (L-26): which of that provider's limits its
 * segment draws. Everything here is about ONE provider (C-23).
 */
export const USAGE_PROVIDER_LEVEL = {
  limitsLabel: "Limits",
  limitsDescription: "Automatic follows the plan reported by the provider.",
  limitsOptions: [
    { value: "automatic", label: "Automatic (recommended)" },
    { value: "choose", label: "Choose..." },
  ] as ReadonlyArray<SegmentOption>,
  /** The checklist `Choose...` opens: this provider's own live windows (L-96). */
  limitsPickLabel: "Limits to draw",
  /**
   * What stands where the checklist would be when the provider has reported
   * nothing yet. Not an error: a provider is read lazily, so "no windows" is
   * the ordinary state of one nobody has used this session - and with nothing
   * to pick, `Automatic` is the only answer there is.
   */
  limitsEmpty:
    "No limits reported yet. Automatic will use the tightest reported limit.",
};
