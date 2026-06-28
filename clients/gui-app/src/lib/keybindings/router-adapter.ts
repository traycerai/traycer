/**
 * Shared so `KeybindingProvider` and `CommandPaletteProvider` expose
 * the same narrow `KeybindingRouter` seam. Kept here (not in the
 * framework-free `dispatch.ts`) because this module is the only
 * place that knows about the concrete TanStack `AppRouter` shape.
 *
 * `navigateToEpicList` / `navigateSettings` / `navigateSettingsSection`
 * route through the system-tab modal bridge first when the modal host
 * has published its API. That preserves the modal-first UX for
 * keybindings + palette commands without coupling those framework-free
 * call sites to React hooks.
 */
import type { RouterHistory, UseNavigateResult } from "@tanstack/react-router";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";
import {
  goBack as goBackAction,
  goForward as goForwardAction,
} from "@/lib/commands/actions";
import { getHistoryController } from "@/lib/persistent-history";
import { LANDING_ROUTE } from "@/lib/routes";
import {
  existingEpicTabIntent,
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { routeIntentViaModalBridge } from "@/stores/tabs/system-overlay-registry";

export interface KeybindingRouterSource {
  readonly state: { readonly location: { readonly pathname: string } };
  // Full `RouterHistory` (not just `subscribe`): the history-navigation seam
  // reads the persistent-history controller brand off it (`getHistoryController`)
  // and walks it via the shared `goBack`/`goForward` actions.
  readonly history: RouterHistory;
  readonly navigate: UseNavigateResult<string>;
}

export function routerAdapterFor(
  router: KeybindingRouterSource,
): KeybindingRouter {
  return {
    getPathname: () => router.state.location.pathname,
    navigateHome: () => {
      void router.navigate(LANDING_ROUTE);
    },
    navigateSettings: () => {
      const api = getSystemTabModalApi();
      if (api === null) return;
      api.openSettings({ section: null, resetToGeneral: true });
    },
    navigateToEpic: (epicId) => {
      navigateToTabIntent(
        router.navigate,
        openOrFocusEpicIntent({ epicId, focus: undefined }),
      );
    },
    navigateToEpicTab: (tab) => {
      navigateToTabIntent(
        router.navigate,
        existingEpicTabIntent({
          epicId: tab.epicId,
          tabId: tab.tabId,
          focus: undefined,
        }),
      );
    },
    navigateToEpicList: () => {
      const api = getSystemTabModalApi();
      if (api === null) return;
      api.openHistory();
    },
    navigateSettingsSection: (sectionId: SettingsSectionId) => {
      const api = getSystemTabModalApi();
      // When the modal is open, sub-leader / palette section picks
      // update the in-modal section without leaving the underlying
      // tab. Otherwise: focus or open the settings surface (modal or
      // tab) on the requested section.
      if (api !== null && api.isOverlayActive("settings")) {
        api.setSection(sectionId);
        return;
      }
      if (api !== null) {
        api.openSettings({ section: sectionId, resetToGeneral: false });
      }
    },
    navigateToTabIntent: (intent) => {
      const api = getSystemTabModalApi();
      if (api !== null && routeIntentViaModalBridge(intent, api)) {
        return;
      }
      navigateToTabIntent(router.navigate, intent);
    },
    // Walk the CURRENT router's persistent history; the shared actions no-op
    // when the history carries no controller brand (browser/web build).
    goBack: () => goBackAction(router),
    goForward: () => goForwardAction(router),
    // History-navigation availability + boundary state off the live router's
    // controller brand. The palette source reads these through `ctx.router`
    // (it mounts above `<RouterProvider>`, where TanStack router context is null).
    isHistoryNavAvailable: () => getHistoryController(router.history) !== null,
    canGoBack: () => {
      const controller = getHistoryController(router.history);
      return controller !== null && controller.canGoBack();
    },
    canGoForward: () => {
      const controller = getHistoryController(router.history);
      return controller !== null && controller.canGoForward();
    },
  };
}
