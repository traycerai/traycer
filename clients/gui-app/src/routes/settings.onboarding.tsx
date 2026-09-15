import { createFileRoute, redirect } from "@tanstack/react-router";
import { OnboardingSettingsPanel } from "@/components/settings/panels/onboarding-settings-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/onboarding")({
  /**
   * Same guard as `settings.keybindings.tsx`: a build that does not offer the
   * section still has its route, because a URL outlives the build that
   * produced it - a bookmark, a remembered tab path, or a toast's "Learn
   * more" link handed a stored section id all land here. They land on
   * General instead, with `replace` so Back leaves Settings rather than
   * bouncing off this route again.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("onboarding")) return;
    redirect({ throw: true, to: "/settings/general", replace: true });
  },
  component: OnboardingSettingsPanel,
});
