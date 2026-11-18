import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppNotificationsSettingsPanel } from "@/components/settings/panels/app-notifications-settings-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/app-notifications")({
  /**
   * Sounds holds only the soundtrack, and a build with nothing to play does
   * not offer it. A bookmark, a remembered tab path or an old link to it lands
   * on Alerts, where its chimes went. `throw: true` and `replace: true` for
   * the reasons `settings.link-phone.tsx` gives.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("app-notifications")) return;
    redirect({ throw: true, to: "/settings/alerts", replace: true });
  },
  component: AppNotificationsSettingsPanel,
});
