import { createLayoutItem, flattenLayoutRefs } from "@/stores/tabs/layout";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { TabNavigationIntent } from "@/lib/tab-navigation/intents";
import { selectHostFocusedRef } from "@/stores/tabs/selectors";
import { toast } from "sonner";
import { OPEN_OVERLAY_SELECTOR } from "@/components/onboarding/guide-overlays";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";
import {
  getCustomizeSetting,
  type CustomizeSettingId,
} from "@/lib/customize/catalog";
import { watchExternalLayoutWrites } from "@/lib/customize/history";
import {
  acquireCustomizeLease,
  releaseCustomizeLease,
  startCustomizeHeartbeat,
} from "@/lib/customize/lease";
import {
  useCustomizeStore,
  type ExitReason,
  type Opener,
  type Scene,
} from "@/stores/customize/customize-store";
import {
  isVisualLayoutEditorEnabled,
  useSettingsStore,
} from "@/stores/settings/settings-store";
import { useTabsStore } from "@/stores/tabs/store";
import { getSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import { settingsSectionFromPath } from "@/stores/tabs/kinds/settings";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  findPaneById,
  resolveActivePaneTab,
} from "@/stores/epics/canvas/tile-tree";

let cleanup: (() => void) | null = null;
let restoreFrame = 0;
let pointerEntry = false;
export function setCustomizeInputMethod(pointer: boolean): void {
  pointerEntry = pointer;
  document.documentElement.toggleAttribute("data-customize-keyboard", !pointer);
}
export function isCustomizePointerInput(): boolean {
  return pointerEntry;
}

export function captureSettingsOpener(): Opener {
  const scrollTop =
    document.querySelector<HTMLElement>("[data-settings-panel-pane]")
      ?.scrollTop ?? 0;
  const modal = getSystemTabModalApi()?.active;
  if (modal?.kind === "settings")
    return {
      kind: "settings-modal",
      section: modal.section ?? "general",
      scrollTop,
    };
  const state = useTabsStore.getState();
  const settings = state.systemTabs.settings;
  const ref = selectHostFocusedRef(state);
  if (settings && ref && "kind" in ref && ref.kind === "settings")
    return {
      kind: "settings-tab",
      tabId: "settings",
      section: settingsSectionFromPath(
        settings.lastPath ?? "/settings/general",
      ),
      scrollTop,
    };
  return { kind: "none" };
}

export function restoreOpener(opener: Opener): void {
  if (opener.kind === "none") return;
  if (
    opener.kind === "settings-tab" &&
    !useTabsStore.getState().systemTabs.settings
  )
    return;
  // The existing bridge also navigates to an already-open Settings tab.
  getSystemTabModalApi()?.openSettings({
    section: opener.section,
    resetToGeneral: false,
  });
  let attempts = 0;
  const restore = () => {
    const pane = document.querySelector<HTMLElement>(
      "[data-settings-panel-pane]",
    );
    if (pane) {
      pane.scrollTop = opener.scrollTop;
      return;
    }
    if (++attempts < 60) restoreFrame = requestAnimationFrame(restore);
  };
  cancelAnimationFrame(restoreFrame);
  restoreFrame = requestAnimationFrame(restore);
}

export function enterCustomize(input: {
  scene: Scene;
  opener: Opener;
  target: CustomizeSettingId | null;
  source?: AnalyticsSource;
}): boolean {
  if (useCustomizeStore.getState().session) return true;
  if (
    !isVisualLayoutEditorEnabled() ||
    isMobileViewport() ||
    !acquireCustomizeLease()
  )
    return false;
  cancelAnimationFrame(restoreFrame);
  // Dismiss the pre-existing topmost Radix layer before the editor owns Esc.
  if (
    Array.from(document.querySelectorAll(OPEN_OVERLAY_SELECTOR)).some(
      (node) => node.getAttribute("data-slot") !== "dialog-content",
    )
  )
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  if (input.opener.kind === "settings-modal") getSystemTabModalApi()?.close();
  useCustomizeStore.setState({
    session: {
      scene: input.scene,
      opener: input.opener,
      startedAt: Date.now(),
      pointerEntry,
    },
    history: { past: [], future: [] },
    search: {
      query: input.target ? getCustomizeSetting(input.target).label : "",
      activeIndex: input.target ? 0 : -1,
    },
    activeKey: null,
    popoverKey: null,
    announcement: "",
    invoker: null,
    pendingTarget: input.target,
  });
  const unwatchHistory = watchExternalLayoutWrites();
  const unwatchTabs = useTabsStore.subscribe((state, previous) => {
    if (state.activeItemId !== previous.activeItemId)
      exitCustomize("tab-switch");
  });
  const unwatchSettings = useSettingsStore.subscribe((state) => {
    if (!state.visualLayoutEditorEnabled) exitCustomize("switch-off");
  });
  const viewport = () => {
    if (isMobileViewport()) exitCustomize("below-md");
  };
  const preferred = () => {
    const state = useEpicCanvasStore.getState();
    const canvas =
      state.activeTabId === null
        ? null
        : state.canvasByTabId[state.activeTabId];
    const pane = canvas?.activePaneId
      ? findPaneById(canvas.root, canvas.activePaneId)
      : null;
    useCustomizeStore.setState({
      preferredTileId: pane
        ? resolveActivePaneTab(pane.activeTabId, pane.tabInstanceIds)
        : null,
    });
  };
  preferred();
  const unwatchFocus = useEpicCanvasStore.subscribe(preferred);
  window.addEventListener("resize", viewport);
  cleanup = () => {
    unwatchHistory();
    unwatchTabs();
    unwatchSettings();
    unwatchFocus();
    window.removeEventListener("resize", viewport);
  };
  startCustomizeHeartbeat(() => exitCustomize("lease-lost"));
  Analytics.getInstance().track(AnalyticsEvent.LayoutEditorOpened, {
    source: input.source ?? "direct_ui",
    scene: input.scene === "sample" ? "sample_workspace" : "in_place",
  });
  return true;
}

export function exitCustomize(reason: ExitReason): void {
  const session = useCustomizeStore.getState().session;
  if (!session) return;
  cleanup?.();
  cleanup = null;
  useCustomizeStore.setState({
    session: null,
    instances: new Map(),
    activeKey: null,
    popoverKey: null,
    invoker: null,
    pendingTarget: null,
    history: { past: [], future: [] },
    search: { query: "", activeIndex: -1 },
  });
  releaseCustomizeLease();
  if (
    session.scene === "sample" &&
    reason !== "tab-switch" &&
    reason !== "lease-lost" &&
    reason !== "studio-closed"
  ) {
    tabCommandCoordinator.closeRefAfterConfirmed({
      kind: "sample-workspace",
      id: "sample-workspace",
    });
  }
  if (reason === "done" || reason === "escape") restoreOpener(session.opener);
  if (reason === "lease-lost")
    toast.info("Customize moved to another window. Your layout is saved.");
}

let sampleOpener: Opener = { kind: "none" };
export function getSampleWorkspaceOpener(): Opener {
  return sampleOpener;
}

/** Returns an intent; the caller uses the normal tab navigation controller. */
export function ensureSampleWorkspaceTab(
  opener: Opener,
): Extract<TabNavigationIntent, { kind: "sample-workspace" }> {
  sampleOpener = opener;
  useTabsStore.setState((state) => {
    const layout = createLayoutItem(state, {
      kind: "sample-workspace",
      id: "sample-workspace",
    });
    return { items: layout.items, stripOrder: flattenLayoutRefs(layout) };
  });
  return { kind: "sample-workspace" };
}
