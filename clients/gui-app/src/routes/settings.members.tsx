import { createFileRoute, redirect } from "@tanstack/react-router";
import { MembersSettingsPanel } from "@/components/settings/environment/members-settings-panel";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

export const Route = createFileRoute("/settings/members")({
  // Not a page of a build without environments: a remembered path lands on
  // Settings.
  beforeLoad: () => {
    if (!UNRELEASED_FEATURES_ENABLED) {
      redirect({ throw: true, to: "/settings", replace: true });
    }
  },
  component: MembersSettingsPanel,
});
