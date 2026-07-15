import {
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import type { WindowsBridgeContextValue } from "@/providers/windows-bridge-context";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { appLogger } from "@/lib/logger";
import {
  applyEpicCanvasDesktopProjection,
  setEpicCanvasDesktopProjectionBridge,
} from "@/stores/epics/canvas/store";
import {
  applyLandingDraftDesktopProjection,
  setLandingDraftDesktopProjectionBridge,
} from "@/stores/home/landing-draft-store";
import { useRunnerHost } from "@/providers/use-runner-host";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import {
  createDebouncedDesktopPerWindowProjectionBridge,
  DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  setActiveDesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import type {
  DesktopPerWindowSnapshot,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

// One `app_opened` per renderer process, emitted when hydration settles (the
// earliest point this window knows whether it restored content). Secondary
// windows are separate renderer processes and count too; the `restored_tabs`
// flag plus PostHog sessions keep launch analyses honest enough without any
// cross-window coordination.
let appOpenedTracked = false;

function trackAppOpenedOnce(restoredTabs: boolean): void {
  if (appOpenedTracked) return;
  appOpenedTracked = true;
  Analytics.getInstance().track(AnalyticsEvent.AppOpened, {
    source: restoredTabs ? "restored_session" : "direct_ui",
    launch_reason: "normal",
    restored_tabs: restoredTabs,
  });
}

interface WindowsBridgeProviderProps {
  readonly children: ReactNode;
}

interface WindowsBridgeHydrationRequest {
  readonly bridge: DesktopWindowsBridge;
}

// Module-level hydration gate. The tab-sync coordinator subscribes
// against the canvas / landing-draft stores at install time; without a
// gate, the per-window snapshot's async arrival would scramble the
// persisted strip order via filter-then-append. We hand the coordinator
// a one-shot promise here BEFORE it installs subscriptions so handlers
// stay suppressed until the first snapshot has been applied (or until
// the renderer confirms there is no desktop bridge to wait on).
let resolveHydrationPromise: (() => void) | null = null;
const hydrationPromise = new Promise<void>((resolve) => {
  resolveHydrationPromise = resolve;
});
installTabSyncCoordinator({ readyPromise: hydrationPromise });

let completedHydrationRequest: WindowsBridgeHydrationRequest | null = null;
const hydrationSubscribers = new Set<() => void>();

function subscribeWindowsBridgeHydration(listener: () => void): () => void {
  hydrationSubscribers.add(listener);
  return () => {
    hydrationSubscribers.delete(listener);
  };
}

function getCompletedHydrationRequest(): WindowsBridgeHydrationRequest | null {
  return completedHydrationRequest;
}

function completeWindowsBridgeHydration(
  request: WindowsBridgeHydrationRequest,
): void {
  if (completedHydrationRequest === request) return;
  completedHydrationRequest = request;
  for (const subscriber of hydrationSubscribers) {
    subscriber();
  }
}

function markHydrated(): void {
  if (resolveHydrationPromise === null) return;
  const resolve = resolveHydrationPromise;
  resolveHydrationPromise = null;
  resolve();
}

/**
 * Resolves the desktop windows bridge from the runner host and wires the
 * per-window projection (open epic tabs, landing drafts, ownership) to it.
 *
 * Auth-session cross-window projection used to live here too, but it has
 * moved into `WindowsBridgeAuthSessionBridge` - that component lives inside
 * `HostRuntimeProvider` where it can talk to `AuthService` directly
 * (`onSessionSnapshotChange` / `ingestProjectedSessionSnapshot`) instead of
 * reading and writing a raw bearer through `useAuthStore`. Host / runtime
 * consumers must NOT read the bearer here; the live runtime auth authority
 * is the `RequestContext` produced by `AuthService.getRequestContextProvider()`.
 */
export function WindowsBridgeProvider(
  props: WindowsBridgeProviderProps,
): ReactNode {
  const runnerHost = useRunnerHost();
  const bridge = useMemo(
    () => resolveDesktopWindowsBridge(runnerHost),
    [runnerHost],
  );
  const hydrationRequest = useMemo<WindowsBridgeHydrationRequest | null>(
    () => (bridge === null ? null : { bridge }),
    [bridge],
  );
  const completedRequest = useSyncExternalStore(
    subscribeWindowsBridgeHydration,
    getCompletedHydrationRequest,
    getCompletedHydrationRequest,
  );
  const hasHydrated =
    hydrationRequest === null || completedRequest === hydrationRequest;

  useLayoutEffect(() => {
    if (bridge === null) return installMissingDesktopWindowsBridge();
    if (hydrationRequest === null) return;
    return installDesktopWindowsBridge(bridge, hydrationRequest);
  }, [bridge, hydrationRequest]);

  const value = useMemo<WindowsBridgeContextValue>(
    () => ({ bridge, hasHydrated }),
    [bridge, hasHydrated],
  );
  return (
    <WindowsBridgeContext.Provider value={value}>
      {props.children}
    </WindowsBridgeContext.Provider>
  );
}

function installMissingDesktopWindowsBridge(): () => void {
  clearDesktopWindowsBridge();
  queueMicrotask(() => {
    trackAppOpenedOnce(false);
    markHydrated();
  });
  return clearDesktopWindowsBridge;
}

function installDesktopWindowsBridge(
  bridge: DesktopWindowsBridge,
  hydrationRequest: WindowsBridgeHydrationRequest,
): () => void {
  const lifecycle = { cancelled: false };
  const projectionBridge = createDebouncedDesktopPerWindowProjectionBridge(
    bridge.perWindowState,
    DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  );
  // Best-effort flush on document teardown (reload / navigation / a window close
  // that does NOT route through the quit intercept). Unlike the `before-quit`
  // fresh-snapshot path - which AWAITS this same flush before answering main -
  // unload handlers cannot await a promise, so we can only kick the flush and
  // return. `flush()` enqueues the pending patch's `perWindowState.update` IPC
  // send on the microtask queue, which the browser drains before it proceeds
  // with the unload, so the send does leave the renderer. Residual gap: if a
  // prior projection `update` is still in flight when this fires, the new patch
  // is chained behind it and may not send before teardown; and main is not
  // guaranteed to finish processing an in-flight send before the renderer dies.
  // The deliberate quit path (Cmd+Q / "Quit Traycer") does not rely on this - it
  // uses the awaited fresh-snapshot flush - so this remains a fallback only.
  const flushProjection = (): void => {
    void projectionBridge.flush();
  };
  setDesktopEpicOwnershipBridge(bridge);
  setActiveDesktopPerWindowProjectionBridge(projectionBridge);
  setEpicCanvasDesktopProjectionBridge(projectionBridge);
  setLandingDraftDesktopProjectionBridge(projectionBridge);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushProjection);
    window.addEventListener("beforeunload", flushProjection);
  }

  const perWindowSubscription = bridge.perWindowState.onChange((snapshot) => {
    applyPerWindowSnapshot(snapshot);
  });

  const isCancelled = (): boolean => lifecycle.cancelled;

  void (async () => {
    if (isCancelled()) return;
    try {
      const snapshot = await bridge.perWindowState.get();
      if (isCancelled()) return;
      applyPerWindowSnapshot(snapshot);
      trackAppOpenedOnce(
        snapshot.epicTabs.length > 0 || snapshot.landingDrafts.length > 0,
      );
    } catch (error) {
      if (isCancelled()) return;
      // Fall back to not applying a snapshot (empty/absent snapshot
      // semantics) rather than leaving hydration permanently pending - a
      // route gated on `useWindowsBridgeHydrated()` (e.g. `/draft/new`) would
      // otherwise spin forever.
      appLogger.error(
        "[windows-bridge] per-window snapshot hydration failed",
        {},
        error,
      );
    }
    queueMicrotask(() => {
      if (!lifecycle.cancelled) {
        completeWindowsBridgeHydration(hydrationRequest);
        markHydrated();
      }
    });
  })();

  return () => {
    lifecycle.cancelled = true;
    perWindowSubscription.dispose();
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushProjection);
      window.removeEventListener("beforeunload", flushProjection);
    }
    void projectionBridge.flush();
    projectionBridge.dispose();
    clearDesktopWindowsBridge();
  };
}

function clearDesktopWindowsBridge(): void {
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  setDesktopEpicOwnershipBridge(null);
  setActiveDesktopPerWindowProjectionBridge(null);
}

function applyPerWindowSnapshot(snapshot: DesktopPerWindowSnapshot): void {
  const normalized = normalizePerWindowSnapshot(snapshot);
  applyEpicCanvasDesktopProjection(normalized);
  applyLandingDraftDesktopProjection(normalized);
}

function normalizePerWindowSnapshot(
  snapshot: DesktopPerWindowSnapshot,
): DesktopPerWindowSnapshot {
  const epicTabs = uniquePerWindowTabs(snapshot.epicTabs);
  const landingDrafts = uniqueLandingDrafts(snapshot.landingDrafts);
  if (
    epicTabs.length === snapshot.epicTabs.length &&
    landingDrafts.length === snapshot.landingDrafts.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    epicTabs,
    landingDrafts,
  };
}

function uniquePerWindowTabs(
  tabs: DesktopPerWindowSnapshot["epicTabs"],
): DesktopPerWindowSnapshot["epicTabs"] {
  const seen = new Set<string>();
  return tabs.flatMap((tab) => {
    if (seen.has(tab.id)) return [];
    seen.add(tab.id);
    return [tab];
  });
}

function uniqueLandingDrafts(
  drafts: DesktopPerWindowSnapshot["landingDrafts"],
): DesktopPerWindowSnapshot["landingDrafts"] {
  const seen = new Set<string>();
  return drafts.flatMap((draft) => {
    if (seen.has(draft.id)) return [];
    seen.add(draft.id);
    return [draft];
  });
}

function resolveDesktopWindowsBridge(
  runnerHost: IRunnerHost,
): DesktopWindowsBridge | null {
  const value: unknown = Reflect.get(runnerHost, "windows");
  return isDesktopWindowsBridge(value) ? value : null;
}

function hasFunctions(
  value: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): boolean {
  for (const key of keys) {
    if (typeof value[key] !== "function") return false;
  }
  return true;
}

const ROOT_FN_KEYS = [
  "list",
  "onChange",
  "requestNew",
  "requestFocus",
  "requestClose",
  "requestOpenEpicInNewWindow",
] as const;
const OWNERSHIP_FN_KEYS = ["snapshot", "claim", "release", "onChange"] as const;
// `clear` is intentionally NOT listed here. It is an optional, capability-probed
// method (see `DesktopWindowsBridge.perWindowState.clear?` in lib/windows/types).
// Requiring it in this guard would make an older preload (built before the
// per-window `clear` RPC existed) fail the WHOLE bridge guard on a
// renderer/preload version skew -> silent fallback to web-mode localStorage,
// reverting canvas/landing-draft persistence. It is probed at the wipe call site
// (`typeof perWindowState.clear === "function"`) instead.
const PER_WINDOW_FN_KEYS = ["get", "update", "onChange"] as const;
const AUTH_FN_KEYS = ["get", "set", "onChange"] as const;

function isDesktopWindowsBridge(value: unknown): value is DesktopWindowsBridge {
  if (!isRecord(value)) return false;
  if (typeof value.windowId !== "string") return false;
  if (!hasFunctions(value, ROOT_FN_KEYS)) return false;
  if (!isRecord(value.ownership) || !isRecord(value.perWindowState)) {
    return false;
  }
  if (!isRecord(value.authSession)) return false;
  return (
    hasFunctions(value.ownership, OWNERSHIP_FN_KEYS) &&
    hasFunctions(value.perWindowState, PER_WINDOW_FN_KEYS) &&
    hasFunctions(value.authSession, AUTH_FN_KEYS)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
