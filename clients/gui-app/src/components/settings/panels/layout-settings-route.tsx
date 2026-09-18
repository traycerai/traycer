import { useEffect, type ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { APPEARANCE } from "@/components/settings/panels/appearance-settings.definitions";
import { LayoutSettingsPanel } from "@/components/settings/panels/layout-settings-panel";
import { useSettingsAvailabilityContext } from "@/hooks/settings/use-settings-availability-context";
import { isCustomizeAvailable } from "@/lib/settings/settings-availability";
import { useSettingsSearchStore } from "@/stores/settings/settings-search-store";

/**
 * The Layout page, or its successor.
 *
 * A component-level redirect rather than `beforeLoad`, because the decision
 * reads a store and the viewport (`customizeEditor`), and a route loader has no
 * subscription to either: resizing the window with the page open, or flipping
 * the switch from another window, has to move this reader without a reload. The
 * redirect replaces the entry, so Back does not land on a page that would only
 * bounce again. The reveal request is armed for the Customize card so the
 * reader arrives at it rather than at the top of Appearance.
 */
export function LayoutSettingsRoute(): ReactNode {
  const moved = isCustomizeAvailable(useSettingsAvailabilityContext());
  const requestReveal = useSettingsSearchStore((state) => state.requestReveal);
  useEffect(() => {
    if (moved) {
      requestReveal("appearance", APPEARANCE.definitions.customizeCard.anchor);
    }
  }, [moved, requestReveal]);
  if (moved) return <Navigate to="/settings/appearance" replace />;
  return <LayoutSettingsPanel />;
}
