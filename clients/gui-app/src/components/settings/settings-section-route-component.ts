import { createElement } from "react";
import { lazyRouteComponent } from "@tanstack/react-router";
import type { SettingsSectionId } from "@/lib/settings-sections";

/**
 * The route component for `/settings/<section>`: that section's panel, loaded
 * on demand through `SettingsPanelForSection`, the one mount point the Settings
 * modal and tab render every panel through.
 *
 * A route file that imported its panel directly would put that panel - and
 * everything it pulls in - on the static path of any bundle that does not
 * code-split routes. Reaching it through `settings-modal-content` keeps every
 * panel in the one Settings chunk, fetched on first open instead of at boot.
 */
export function settingsSectionRouteComponent(section: SettingsSectionId) {
  return lazyRouteComponent(() =>
    import("@/components/settings/settings-modal-content").then((module) => ({
      default: function SettingsSectionRoutePanel() {
        return createElement(module.SettingsPanelForSection, { section });
      },
    })),
  );
}
