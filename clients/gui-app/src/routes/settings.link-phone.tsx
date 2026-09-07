import { createFileRoute, redirect } from "@tanstack/react-router";
import { LinkPhonePanel } from "@/components/settings/panels/link-phone-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/link-phone")({
    /**
   * Builds that omit this section still have its route. Redirect to General with `throw: true` and `replace: true` so Back leaves Settings.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("link-phone")) return;
    redirect({ throw: true, to: "/settings/general", replace: true });
  },
  component: LinkPhonePanel,
});
