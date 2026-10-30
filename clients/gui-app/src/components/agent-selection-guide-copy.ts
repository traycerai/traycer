import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

/**
 * The guide's own description and revert label as they read before
 * environments, which dropped the one and renamed the other: a build without
 * them (`unreleased-features.ts`) keeps both.
 */
export const AGENT_SELECTION_GUIDE_DESCRIPTION: string | null =
  UNRELEASED_FEATURES_ENABLED
    ? null
    : "Instructions for choosing Traycer agents' harnesses, models, and reasoning effort. Provider-native subagents follow their provider's configuration and do not have separate Traycer agent IDs.";

export const AGENT_SELECTION_GUIDE_REVERT_LABEL = UNRELEASED_FEATURES_ENABLED
  ? "Reset to default"
  : "Revert to default";
