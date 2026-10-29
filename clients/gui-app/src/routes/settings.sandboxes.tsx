import { createFileRoute, redirect } from "@tanstack/react-router";
import { SandboxesSettingsPanel } from "@/components/settings/panels/sandboxes-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/sandboxes")({
  // Not a page of a build without sandboxes: a remembered path lands on
  // Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: SandboxesSettingsPanel,
});
