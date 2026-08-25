import { createFileRoute, redirect } from "@tanstack/react-router";
import { LinkPhonePanel } from "@/components/settings/panels/link-phone-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/link-phone")({
  /**
   * Builds that do not offer this section still have its route, because a URL
   * outlives the build that produced it - a bookmark, a remembered tab path,
   * or a settings entry point handed a stored section id all land here. They
   * land on General instead, which is where `/settings` itself resolves and
   * what the settings modal falls back to, rather than on a page with no row
   * in the navigation beside it.
   *
   * `throw: true` makes `redirect()` throw the redirect Response itself instead
   * of returning it - the canonical TanStack Router short-circuit, with the
   * explicit `throw` keyword kept out of our source so the `only-throw-error`
   * lint stays happy. `replace: true` keeps the redirected-from entry out of
   * the history stack, so Back leaves Settings instead of bouncing off this
   * route again.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("link-phone")) return;
    redirect({ throw: true, to: "/settings/general", replace: true });
  },
  component: LinkPhonePanel,
});
