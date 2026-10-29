import { createFileRoute, redirect } from "@tanstack/react-router";
import { SecretsSettingsPanel } from "@/components/settings/panels/secrets-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/secrets")({
  // Not a page of a build without environments: a remembered path lands on
  // Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: SecretsSettingsPanel,
});
