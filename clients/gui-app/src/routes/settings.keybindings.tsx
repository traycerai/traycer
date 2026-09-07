import { createFileRoute, redirect } from "@tanstack/react-router";
import { KeybindingsSettingsPanel } from "@/components/settings/panels/keybindings-settings-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/keybindings")({
    /**
   * Builds that omit this section still have its route. Redirect to General with `throw: true` and `replace: true` so Back leaves Settings.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("keybindings")) return;
    redirect({ throw: true, to: "/settings/general", replace: true });
  },
  component: KeybindingsSettingsPanel,
});
