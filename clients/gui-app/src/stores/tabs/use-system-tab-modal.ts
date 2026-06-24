import { useCallback, useEffect, useMemo, useRef } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useTabsStore } from "@/stores/tabs/store";
import { useSettingsSectionStore } from "@/stores/tabs/settings-section-store";
import {
  ensureHistoryTab,
  ensureSettingsTab,
} from "@/lib/commands/actions/open-system-tab";
import { type TabNavigationIntent } from "@/lib/tab-navigation";
import { tabActivate, tabRouteOptions } from "@/stores/tabs/registry";
import {
  parseSystemTabOverlayView,
  withOverlayCleared,
  type SystemTabOverlayView,
} from "@/lib/system-tab-overlay-search";
import type { SettingsSectionId } from "@/lib/settings-sections";
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
  /** Returns `true` when the modal is currently open for `kind`. */
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

/**
 * Command-only API for surfaces that open or close system overlays.
 *
 * This intentionally does not subscribe to overlay state or settings-section
 * state. Header buttons, model pickers, and keybinding handlers should not
 * re-render when the Settings modal changes sections.
 */
export function useSystemTabModalActions(): SystemTabModalActions {
  const router = useRouter();
  const navigateToTabClearingOverlay = useNavigateToTabClearingOverlay();

  const openSettings = useCallback(
    (opts: OpenSettingsModalOpts) => {
      const settingsTab = useTabsStore.getState().systemTabs.settings;
      if (settingsTab !== null) {
        navigateToTabClearingOverlay(
          ensureSettingsTab({
            subSection: opts.section,
            resetToGeneral: opts.resetToGeneral,
          }),
        );
        return;
      }
      // Section now lives in the store (not the URL), so opening resets it the
      // same way the old `overlaySection` param did: an explicit section / the
      // reset flag wins, otherwise fall back to General. Section navigation
      // afterwards never touches the router.
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
    const historyTab = useTabsStore.getState().systemTabs.history;
    if (historyTab !== null) {
      navigateToTabClearingOverlay(ensureHistoryTab());
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
    // History search/filter/sort lives in the ambient store and must persist for
    // the whole app session, so dismissing the modal only sweeps the URL overlay
    // flag - reopening restores exactly where the user left off.
    void router.navigate({
      to: ".",
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
    navigateToTabClearingOverlay(overlayPromotionIntent(active));
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
) => void {
  const router = useRouter();
  return useCallback(
    (target: TabNavigationIntent): void => {
      tabActivate(target);
      void router.navigate({
        ...tabRouteOptions(target),
        search: (prev) => withOverlayCleared(prev),
      });
    },
    [router],
  );
}

function overlayPromotionIntent(
  active: SystemModalActive,
): TabNavigationIntent {
  if (active.kind === "settings") {
    return ensureSettingsTab({
      subSection: active.section,
      resetToGeneral: false,
    });
  }
  return ensureHistoryTab();
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
 * Reads + parses the root overlay search params reactively. Returns a
 * `SystemTabOverlayView` (all booleans, no `undefined`) so consumers
 * don't repeat the default-application themselves.
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

/**
 * Refresh / deep-link guard + path-change auto-close. Mounted once
 * inside `<SystemTabModalHost />`. Two responsibilities:
 *  1. When the URL carries an overlay flag but a strip tab of that
 *     kind is already open, navigate to the tab's route and drop the
 *     overlay search params (focus-tab-first on cold load).
 *  2. When the underlying path changes while the modal is open, clear
 *     the overlay flags so the modal dismisses.
 */
export function useSystemTabModalRefreshGuard(): void {
  const overlay = useOverlaySearch();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const router = useRouter();
  const lastPathnameRef = useRef<string>(pathname);

  useEffect(() => {
    if (!overlay.settingsOverlay && !overlay.historyOverlay) {
      lastPathnameRef.current = pathname;
      return;
    }
    const systemTabs = useTabsStore.getState().systemTabs;
    if (overlay.settingsOverlay && systemTabs.settings !== null) {
      const target = ensureSettingsTab({
        subSection: useSettingsSectionStore.getState().section,
        resetToGeneral: false,
      });
      tabActivate(target);
      void router.navigate({
        ...tabRouteOptions(target),
        search: (prev) => withOverlayCleared(prev),
      });
      return;
    }
    if (overlay.historyOverlay && systemTabs.history !== null) {
      const target = ensureHistoryTab();
      tabActivate(target);
      void router.navigate({
        ...tabRouteOptions(target),
        search: (prev) => withOverlayCleared(prev),
      });
      return;
    }
    if (pathname !== lastPathnameRef.current) {
      // Auto-close on path change drops only the overlay flag; the ambient
      // history search/filter/sort is preserved for the session.
      void router.navigate({
        to: ".",
        search: (prev) => withOverlayCleared(prev),
      });
      lastPathnameRef.current = pathname;
      return;
    }
    lastPathnameRef.current = pathname;
  }, [router, overlay, pathname]);
}
