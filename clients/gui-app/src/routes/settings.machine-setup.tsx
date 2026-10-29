import { createFileRoute, redirect } from "@tanstack/react-router";
import { MachineSetupSettingsPanel } from "@/components/settings/panels/machine-setup-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/machine-setup")({
  // Not a page of a build without environments: a remembered path lands on
  // Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: MachineSetupSettingsPanel,
});
