import { createFileRoute, redirect } from "@tanstack/react-router";
import { DeleteAccountSettingsPanel } from "@/components/settings/panels/delete-account-settings-panel";
import { isSettingsSectionVisible } from "@/lib/settings-sections";

export const Route = createFileRoute("/settings/delete-account")({
  /**
   * The mirror of `settings.keybindings.tsx` and `settings.link-phone.tsx`,
   * for a section offered only by the OTHER build: this route exists
   * everywhere because a URL outlives the build that produced it - a
   * bookmark, a remembered tab path, or a settings entry point handed a
   * stored section id all land here - and everywhere but the installed mobile
   * app it resolves to General, the same fallback `/settings` itself and the
   * settings modal use, rather than to a page with no row in the navigation
   * beside it.
   *
   * `throw: true` makes `redirect()` throw the redirect Response itself instead
   * of returning it - the canonical TanStack Router short-circuit, with the
   * explicit `throw` keyword kept out of our source so the `only-throw-error`
   * lint stays happy. `replace: true` keeps the redirected-from entry out of
   * the history stack, so Back leaves Settings instead of bouncing off this
   * route again.
   */
  beforeLoad: () => {
    if (isSettingsSectionVisible("delete-account")) return;
    redirect({ throw: true, to: "/settings/general", replace: true });
  },
  component: DeleteAccountSettingsPanel,
});
