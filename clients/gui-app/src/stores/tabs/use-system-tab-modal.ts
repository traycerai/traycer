import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useRouter,
  useRouterState,
  type RouterHistory,
} from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import { hrefPathname } from "@/lib/routes";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import {
  resolveHistoryTabIntent,
  resolveSettingsTabIntent,
} from "@/lib/commands/actions/open-system-tab";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { settingsRouteOptions } from "@/stores/tabs/kinds/settings";
import {
  activateTabIntent,
  type TabNavigationIntent,
} from "@/lib/tab-navigation";
import {
  parseSystemTabOverlayView,
  withOverlayCleared,
  SYSTEM_OVERLAY_PARAM_KEYS,
  type SystemTabOverlayView,
} from "@/lib/system-tab-overlay-search";
import type { SettingsSectionId } from "@/lib/settings-sections";
import { historySearchToParams } from "@/lib/history-search";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import {
  type OpenSettingsModalOpts,
  type SystemModalActive,
  type SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";

export type {
  OpenSettingsModalOpts,
  SystemModalActive,
  SystemModalKind,
  SystemOverlayKind,
} from "@/stores/tabs/system-overlay-types";

export interface SystemTabModalApi {
  readonly active: SystemModalActive | null;
  readonly openSettings: (opts: OpenSettingsModalOpts) => void;
  readonly openHistory: () => void;
  readonly close: () => void;
  readonly setSection: (section: SettingsSectionId) => void;
  readonly promoteToTab: () => void;
  readonly isOverlayActive: (kind: SystemOverlayKind) => boolean;
}

export interface SystemTabModalActions {
  readonly openSettings: (opts: OpenSettingsModalOpts) => void;
  readonly openHistory: () => void;
  readonly close: () => void;
  readonly setSection: (section: SettingsSectionId) => void;
}

export interface SystemTabModalState {
  readonly active: SystemModalActive | null;
}

type TabActivationSource = "focus-existing" | "promote-modal";

/**
 * Command-only API for surfaces that open or close system overlays. This intentionally does not
 * subscribe to overlay state or settings-section state.
 */
export function useSystemTabModalActions(): SystemTabModalActions {
  const router = useRouter();
  const navigateToTabClearingOverlay = useNavigateToTabClearingOverlay();

  const openSettings = useCallback(
    (opts: OpenSettingsModalOpts) => {
      // On phones the two-pane modal never opens: settings is only the full-page drill-down.
      if (isMobileViewport()) {
        // No `search` reducer: leaving the current route drops the overlay
        // params on its own, and the settings routes carry no search schema.
        if (opts.section !== null) {
          void router.navigate(settingsRouteOptions(opts.section));
          return;
        }
        void router.navigate({ to: "/settings" });
        return;
      }
      const settingsTab = useTabsStore.getState().systemTabs.settings;
      if (settingsTab !== null) {
        navigateToTabClearingOverlay(
          resolveSettingsTabIntent({
            subSection: opts.section,
            resetToGeneral: opts.resetToGeneral,
          }),
          "focus-existing",
        );
        return;
      }
      // Section navigation afterwards never touches the router.
      useSettingsSectionStore
        .getState()
        .setSection(opts.resetToGeneral ? "general" : (opts.section ?? null));
      void router.navigate({
        to: ".",
        search: (prev) => ({
          ...withOverlayCleared(prev),
          settingsOverlay: true,
        }),
      });
    },
    [navigateToTabClearingOverlay, router],
  );

  const openHistory = useCallback(() => {
    // On phones History is only the full-page `/epics` route, never the modal or a strip tab.
    if (isMobileViewport()) {
      void router.navigate({
        to: "/epics",
        search: historySearchToParams(useHistorySearchStore.getState().search),
      });
      return;
    }
    const historyTab = useTabsStore.getState().systemTabs.history;
    if (historyTab !== null) {
      navigateToTabClearingOverlay(resolveHistoryTabIntent(), "focus-existing");
      return;
    }
    void router.navigate({
      to: ".",
      search: (prev) => ({
        ...withOverlayCleared(prev),
        historyOverlay: true,
      }),
    });
  }, [navigateToTabClearingOverlay, router]);

  const close = useCallback(() => {
    // History search/filter/sort lives in the ambient store and must persist for the whole app
    // session, so dismissing the modal only sweeps the URL overlay flag - reopening restores exactly
    if (canPopOverlayEntry(router.history)) {
      router.history.back();
      return;
    }
    void router.navigate({
      to: ".",
      replace: true,
      search: (prev) => withOverlayCleared(prev),
    });
  }, [router]);

  const setSection = useCallback((section: SettingsSectionId) => {
    // Store-only: section nav must not navigate the root route (that re-rendered
    // the whole shell behind the modal).
    useSettingsSectionStore.getState().setSection(section);
  }, []);

  return useMemo(
    () => ({
      openSettings,
      openHistory,
      close,
      setSection,
    }),
    [openSettings, openHistory, close, setSection],
  );
}

/**
 * Reactive modal state for the host/content boundary. This is the only public
 * hook that subscribes to `useSettingsSectionStore`.
 */
export function useSystemTabModalState(): SystemTabModalState {
  const overlay = useOverlaySearch();
  const settingsSection = useSettingsSectionStore((state) => state.section);
  const active = useMemo(
    () =>
      activeFromOverlayFlags(
        overlay.settingsOverlay,
        overlay.historyOverlay,
        settingsSection,
      ),
    [overlay.settingsOverlay, overlay.historyOverlay, settingsSection],
  );

  return useMemo(() => ({ active }), [active]);
}

/**
 * Host-level controller: state + actions + promote behavior. Trigger surfaces
 * should use `useSystemTabModalActions` / `useSystemOverlayActive` instead.
 */
export function useSystemTabModalController(): SystemTabModalApi {
  const { active } = useSystemTabModalState();
  const actions = useSystemTabModalActions();
  const navigateToTabClearingOverlay = useNavigateToTabClearingOverlay();

  const promoteToTab = useCallback(() => {
    if (active === null) return;
    navigateToTabClearingOverlay(
      overlayPromotionIntent(active),
      "promote-modal",
    );
  }, [active, navigateToTabClearingOverlay]);

  const isOverlayActive = useCallback(
    (kind: SystemOverlayKind): boolean => active?.kind === kind,
    [active?.kind],
  );

  return useMemo(
    () => ({
      active,
      openSettings: actions.openSettings,
      openHistory: actions.openHistory,
      close: actions.close,
      setSection: actions.setSection,
      promoteToTab,
      isOverlayActive,
    }),
    [
      active,
      actions.openSettings,
      actions.openHistory,
      actions.close,
      actions.setSection,
      promoteToTab,
      isOverlayActive,
    ],
  );
}

function useNavigateToTabClearingOverlay(): (
  target: TabNavigationIntent,
  source: TabActivationSource,
) => void {
  const router = useRouter();
  return useCallback(
    (target: TabNavigationIntent, source: TabActivationSource): void => {
      // Promotion carries the modal's visible state regardless of whether a History tab already exists.
      const historySearch =
        target.kind === "history" && source === "promote-modal"
          ? historySearchToParams(useHistorySearchStore.getState().search)
          : null;
      activateTabIntent(router.navigate, target, {
        search: (prev) => ({
          ...withOverlayCleared(prev),
          ...(historySearch ?? {}),
        }),
      });
    },
    [router],
  );
}

function overlayPromotionIntent(
  active: SystemModalActive,
): TabNavigationIntent {
  if (active.kind === "settings") {
    return resolveSettingsTabIntent({
      subSection: active.section,
      resetToGeneral: false,
    });
  }
  return resolveHistoryTabIntent();
}

/**
 * The overlay entry was pushed onto the underlying page (`openSettings` / `openHistory` navigate
 * with `to: "."`), so the entry directly behind it shares the same pathname.
 */
export function canPopOverlayEntry(history: RouterHistory): boolean {
  const controller = getHistoryController(history);
  if (controller === null) return false;
  const index = controller.getIndex();
  if (index <= 0) return false;
  const entries = controller.getEntries();
  // `index > 0` and the controller keeps `index` in range, so both reads are present. Pop ONLY when
  // the entry behind us is the overlay-free underlying page: same pathname AND no overlay flag.
  return (
    hrefPathname(entries[index]) === hrefPathname(entries[index - 1]) &&
    !hrefHasActiveOverlay(entries[index - 1])
  );
}

/** True when a stored href's search carries an active overlay flag. */
function hrefHasActiveOverlay(href: string): boolean {
  const queryStart = href.indexOf("?");
  if (queryStart === -1) return false;
  const hashStart = href.indexOf("#");
  const search =
    hashStart === -1
      ? href.slice(queryStart + 1)
      : href.slice(queryStart + 1, hashStart);
  const params = new URLSearchParams(search);
  return SYSTEM_OVERLAY_PARAM_KEYS.some((key) => params.has(key));
}

function activeFromOverlayFlags(
  settingsOverlay: boolean,
  historyOverlay: boolean,
  settingsSection: SettingsSectionId | null,
): SystemModalActive | null {
  if (settingsOverlay) {
    return { kind: "settings", section: settingsSection };
  }
  if (historyOverlay) {
    return { kind: "history", section: null };
  }
  return null;
}

/**
 * Reads + parses the root overlay search params reactively. Returns a `SystemTabOverlayView` (all
 * booleans, no `undefined`) so consumers don't repeat the default-application themselves.
 */
export function useOverlaySearch(): SystemTabOverlayView {
  return useRouterState({
    select: (state) => parseSystemTabOverlayView(state.location.search),
  });
}

export function useSystemOverlayActive(kind: SystemOverlayKind): boolean {
  return useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return kind === "settings"
        ? overlay.settingsOverlay
        : overlay.historyOverlay;
    },
  });
}

export function useAnySystemOverlayActive(): boolean {
  return useRouterState({
    select: (state) => {
      const overlay = parseSystemTabOverlayView(state.location.search);
      return overlay.settingsOverlay || overlay.historyOverlay;
    },
  });
}

// Module-scoped: "once per renderer boot," not once per component instance. A component-instance ref
// would reset every time an ancestor remounts the tree this hook lives in (e.g.
let systemTabModalColdLoadReconciled = false;

/** Test-only: resets the module-scoped cold-load latch between test cases. */
export function resetSystemTabModalColdLoadForTests(): void {
  systemTabModalColdLoadReconciled = false;
}

/**
 * Refresh / deep-link guard + path-change auto-close. Mounted once inside `<SystemTabModalHost
 * />`.
 */
export function useSystemTabModalRefreshGuard(): void {
  const overlay = useOverlaySearch();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const router = useRouter();
  const lastPathnameRef = useRef<string>(pathname);

  useEffect(() => {
    const isColdLoad = !systemTabModalColdLoadReconciled;
    systemTabModalColdLoadReconciled = true;

    if (!overlay.settingsOverlay && !overlay.historyOverlay) {
      lastPathnameRef.current = pathname;
      return;
    }
    const systemTabs = useTabsStore.getState().systemTabs;
    if (isColdLoad && overlay.settingsOverlay && systemTabs.settings !== null) {
      const target = resolveSettingsTabIntent({
        subSection: useSettingsSectionStore.getState().section,
        resetToGeneral: false,
      });
      activateTabIntent(router.navigate, target, {
        replace: true,
        search: (prev) => withOverlayCleared(prev),
      });
      return;
    }
    if (isColdLoad && overlay.historyOverlay && systemTabs.history !== null) {
      const target = resolveHistoryTabIntent();
      activateTabIntent(router.navigate, target, {
        replace: true,
        search: (prev) => withOverlayCleared(prev),
      });
      return;
    }
    if (pathname !== lastPathnameRef.current) {
      // Auto-close on path change drops only the overlay flag; the ambient history search/filter/sort is
      // preserved for the session.
      void router.navigate({
        to: ".",
        replace: true,
        search: (prev) => withOverlayCleared(prev),
      });
      lastPathnameRef.current = pathname;
      return;
    }
    lastPathnameRef.current = pathname;
  }, [router, overlay, pathname]);
}
