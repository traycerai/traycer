import type { SegmentOption } from "@/components/layout-editor/regions/region-grammar";

/**
 * Which of one provider's limits its readings draw, now a section of the
 * provider's page in Settings. Everything here is about ONE provider.
 */
export const USAGE_PROVIDER_LEVEL = {
  /** The section's one heading: the row's label is the section's name. */
  limitsLabel: "Usage limits",
  limitsDescription: "Automatic: uses the limits your provider reports.",
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
  limitsEmpty: "No limits reported.",
};
