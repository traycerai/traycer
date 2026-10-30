import { createFileRoute, redirect } from "@tanstack/react-router";
import { CreditsSettingsPanel } from "@/components/settings/panels/credits-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/credits")({
  // Not a page of a build without sandboxes: a remembered path lands on
  // Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: CreditsSettingsPanel,
});
