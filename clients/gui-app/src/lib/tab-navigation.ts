import type {
  NavigateOptions,
  UseNavigateResult,
} from "@tanstack/react-router";
import { tabActivate, tabRouteOptions } from "@/stores/tabs/registry";
import { settingsSectionFromPath } from "@/stores/tabs/kinds/settings";

export {
  draftTabIntent,
  existingEpicTabIntent,
  existingEpicTabIntentWithNestedFocus,
  historyTabIntent,
  openOrFocusEpicIntent,
  settingsTabIntent,
  type EpicRouteFocus,
  type TabNavigationIntent,
} from "@/lib/tab-navigation/intents";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";

export { settingsSectionFromPath };

type NavigateFn = UseNavigateResult<string>;

/**
 * Single canonical seam for activating a tab and routing to it.
 *
 * Every entry point that switches the active tab - UI clicks
 * (`tab-strip.tsx`), keybinding chords (`lib/keybindings/dispatch.ts`
 * via `KeybindingRouter.navigateToTabIntent`), command palette,
 * notification focus, and DnD drops onto the header strip - funnels
 * through here. Cross-cutting behavior (telemetry, focus restoration,
 * per-kind state activation) lands once and applies to every path.
 *
 * The matching ESLint rule in `.eslintrc.cjs` blocks calling
 * `setActiveTab` / `setActiveDraft` directly outside this seam.
 */
export function navigateToTabIntent(
  navigate: NavigateFn,
  intent: TabNavigationIntent,
  ...[options]: [] | [Pick<NavigateOptions, "replace">]
): void {
  tabActivate(intent);
  const routeOptions = tabRouteOptions(intent);
  void navigate(
    options === undefined ? routeOptions : { ...routeOptions, ...options },
  );
}
