import {
  browserCanvasHydration,
  isBrowserCanvasHydrated,
  subscribeBrowserCanvasHydration,
} from "@/lib/tab-sync/browser-canvas-hydration";
import {
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import type { WindowsBridgeContextValue } from "@/providers/windows-bridge-context";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { appLogger, describeLogError } from "@/lib/logger";
import {
  applyEpicCanvasDesktopProjection,
  setEpicCanvasDesktopProjectionBridge,
} from "@/stores/epics/canvas/store";
import {
  applyCanonicalLandingDraftAliases,
  applyLandingDraftDesktopProjection,
  importCanonicalLandingDraftProjection,
  readCanonicalLandingDraft,
  setLandingDraftDesktopProjectionBridge,
} from "@/stores/home/landing-draft-store";
import { adoptDraftImageHandoff } from "@/lib/composer/landing-image-move";
import {
  bindDesktopDraftTopology,
  holdDesktopDraftAttachDuringNegotiation,
  markDesktopDraftAttachReady,
  observeDesktopDraftTopology,
  toCanonicalLandingDraftReference,
  toDesktopLandingDraftReference,
} from "@/lib/windows/desktop-draft-topology";
import { useRunnerHost } from "@/providers/use-runner-host";
import { setDesktopEpicOwnershipBridge } from "@/lib/windows/desktop-epic-ownership";
import { installCrossWindowEpicVisibility } from "@/lib/epics/cross-window-epic-visibility";
import { installDesktopWindowVisibility } from "@/lib/epics/desktop-window-visibility";
import { installDesktopBackgroundRendering } from "@/lib/browser-view/tiles/desktop-background-rendering";
import {
  createDebouncedDesktopPerWindowProjectionBridge,
  DESKTOP_PER_WINDOW_PROJECTION_DEBOUNCE_MS,
  setActiveDesktopPerWindowProjectionBridge,
} from "@/lib/windows/per-window-projection-debounce";
import {
  clearDesktopTabsPersistence,
  commitAppliedDesktopTabsSnapshot,
  configureBrowserTabsPersistence,
  configureDesktopTabsAuthority,
  drainDesktopTabsPersistence,
  hydrateDesktopTabs,
  hydrateInitialDesktopTabs,
  installDesktopTabsPersistence,
  isDesktopTabsCapabilitySupported,
  shouldApplyDesktopTabsSnapshot,
} from "@/stores/tabs/desktop-tabs-persistence";
import { readPersistedCurrentRoute } from "@/lib/persistent-history";
import {
  bindTracySurfaceToWindow,
  forgetClosedTracySurfaceWindows,
  readTracySurfaceWindowRecords,
  settleTracySurfaceAdoption,
} from "@/stores/bots/tracy-surface-store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import type {
  DesktopPerWindowSnapshot,
  DesktopPerWindowStateCapabilities,
  DesktopWindowDraftTopology,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { fileEditRuntimeRegistry } from "@/lib/workspace/file-edit-runtime-registry";

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

interface DesktopTabsVerification {
  readonly supported: boolean;
  readonly acknowledgedRevision: number | null;
}

interface DesktopSnapshotApplication {
  readonly revision: number;
  readonly result: Promise<boolean>;
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
  const browserHydrated = useSyncExternalStore(
    subscribeBrowserCanvasHydration,
    isBrowserCanvasHydrated,
    isBrowserCanvasHydrated,
  );
  const hasHydrated =
    hydrationRequest === null
      ? browserHydrated
      : completedRequest === hydrationRequest;

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
  configureBrowserTabsPersistence();
  // No desktop bridge here (web/browser path), so `installDesktopWindowsBridge`
  // below never runs and its `pagehide`/`beforeunload` flush never installs
  // either. File-edit drafts still need that flush independent of the bridge:
  // without it, a reload within the 100ms recovery debounce after typing loses
  // the draft (only in renderer memory, never reaching the IndexedDB journal).
  const flushFileEditRecovery = (): void => {
    void fileEditRuntimeRegistry.flushRecovery().catch(() => undefined);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushFileEditRecovery);
    window.addEventListener("beforeunload", flushFileEditRecovery);
  }
  // A browser still has an asynchronous auth-to-account-canvas handoff.
  // Opening reconciliation before that handoff prunes/reorders persisted tabs.
  void browserCanvasHydration.then(() => {
    trackAppOpenedOnce(false);
    markHydrated();
  });
  return () => {
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushFileEditRecovery);
      window.removeEventListener("beforeunload", flushFileEditRecovery);
    }
    clearDesktopWindowsBridge();
  };
}

function installDesktopWindowsBridge(
  bridge: DesktopWindowsBridge,
  hydrationRequest: WindowsBridgeHydrationRequest,
): () => void {
  // This window's own Tracy surface record, before anything writes to it.
  bindTracySurfaceToWindow(bridge.windowId);
  const lifecycle = { cancelled: false };
  let referenceMode = false;
  let unbindDraftTopology: (() => void) | null = null;
  const exposesDraftReferences =
    typeof bridge.moveDraftReference === "function" &&
    typeof bridge.perWindowState.flushDraftTopology === "function" &&
    typeof bridge.perWindowState.updateDraftReferences === "function";
  const finishAttachNegotiation = exposesDraftReferences
    ? holdDesktopDraftAttachDuringNegotiation()
    : null;
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
    void projectionBridge.flush().catch(() => undefined);
    void drainDesktopTabsPersistence().catch(() => undefined);
    void fileEditRuntimeRegistry.flushRecovery().catch(() => undefined);
  };
  setDesktopEpicOwnershipBridge(bridge);
  // Renderer parking's cross-window arm (plan C, C6). Installed beside the
  // ownership bridge because it has the same lifetime and the same degradation
  // story, and torn down in this effect's cleanup rather than in
  // `clearDesktopWindowsBridge` - that helper also runs on the NO-bridge path,
  // where nothing was installed to undo.
  //
  // The window-level input FIRST: the cross-window install reports this
  // window's claim synchronously, and that report reads the document gate.
  const uninstallDesktopWindowVisibility =
    installDesktopWindowVisibility(bridge);
  const uninstallDesktopBackgroundRendering =
    installDesktopBackgroundRendering(bridge);
  const uninstallCrossWindowVisibility =
    installCrossWindowEpicVisibility(bridge);
  setActiveDesktopPerWindowProjectionBridge(projectionBridge);
  setEpicCanvasDesktopProjectionBridge(projectionBridge);
  setLandingDraftDesktopProjectionBridge({
    ...projectionBridge,
    update: (patch) =>
      referenceMode ? Promise.resolve() : projectionBridge.update(patch),
  });
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushProjection);
    window.addEventListener("beforeunload", flushProjection);
  }

  let latest: DesktopPerWindowSnapshot | null = null;
  let application: DesktopSnapshotApplication | null = null;
  let verification: DesktopTabsVerification | null = null;
  let initialization: Promise<void> | null = null;
  let hydrated = false;
  const imageAdoptions = new Map<string, Promise<void>>();
  const isCancelled = (): boolean => lifecycle.cancelled;

  const completeHydration = (): void => {
    hydrated = true;
    queueMicrotask(() => {
      if (isCancelled()) return;
      markDesktopDraftAttachReady(bridge);
      completeWindowsBridgeHydration(hydrationRequest);
      markHydrated();
    });
  };

  const applyNewestSnapshot = (
    incoming: DesktopPerWindowSnapshot,
  ): Promise<boolean> => {
    if (isCancelled()) return Promise.resolve(false);
    if (latest === null || (incoming.revision ?? 0) > (latest.revision ?? 0)) {
      latest = normalizePerWindowSnapshot(incoming);
    }
    const snapshot = latest;
    const tabs = verification;
    if (tabs === null) return Promise.resolve(false);

    const revision = snapshot.revision ?? 0;
    if (application?.revision === revision) return application.result;
    const isCurrent = (): boolean => !isCancelled() && latest === snapshot;
    const result = Promise.resolve().then(async () => {
      if (!isCurrent()) return false;
      if (snapshot.draftTopology !== undefined) {
        observeDesktopDraftTopology(bridge, snapshot.draftTopology);
        const applied = await applyDesktopDraftTopology(
          snapshot.draftTopology,
          imageAdoptions,
          isCurrent,
        );
        if (!applied || !isCurrent()) return false;
      } else if (referenceMode) {
        const imported = await importCanonicalLandingDraftProjection(snapshot);
        if (imported.kind !== "committed" || !isCurrent()) return false;
        const changed = await bridge.perWindowState.updateDraftReferences?.({
          expectedTopologyRevision: null,
          edits: imported.references.map((reference) => ({
            kind: "attach",
            ref: toDesktopLandingDraftReference(reference),
          })),
          activeDraftId: imported.activeDraftId,
        });
        if (changed === undefined || changed.result === "unavailable") return false;
        const committed = await bridge.perWindowState.get();
        return committed.draftTopology !== undefined && applyNewestSnapshot(committed);
      } else {
        applyLandingDraftDesktopProjection(snapshot);
      }

      applyEpicCanvasDesktopProjection(snapshot);
      if (!hydrated) {
        configureDesktopTabsAuthority(tabs.supported);
        const restored = hydrateInitialDesktopTabs(
          snapshot,
          tabs.supported,
          readPersistedCurrentRoute(bridge.windowId),
        );
        if (tabs.supported && tabs.acknowledgedRevision !== null) {
          installDesktopTabsPersistence(
            bridge,
            Math.max(restored.revision, tabs.acknowledgedRevision),
          );
        }
        trackAppOpenedOnce(
          snapshot.epicTabs.length > 0 ||
          (snapshot.draftTopology?.references.length ??
            snapshot.landingDrafts.length) > 0,
        );
        completeHydration();
      } else if (tabs.supported && shouldApplyDesktopTabsSnapshot(snapshot)) {
        hydrateDesktopTabs(snapshot, true, null);
        commitAppliedDesktopTabsSnapshot(snapshot);
      }
      return true;
    }).catch((error: unknown) => {
      appLogger.error("[windows-bridge] per-window snapshot hydration failed", {}, error);
      return false;
    });
    application = { revision, result };
    void result.then((applied) => {
      if (!applied && application?.result === result) application = null;
    });
    return result;
  };

  const perWindowSubscription = bridge.perWindowState.onChange((snapshot) => {
    void applyNewestSnapshot(snapshot);
  });

  // The desktop's windows, asked once: the first adopts the global Tracy
  // record, and the records read before asking are swept against them.
  // Nothing waits on the answer: the window hydrates from its own record.
  const surfaceRecords = readTracySurfaceWindowRecords();
  const windowIds = Promise.resolve()
    .then(() => bridge.list())
    .then((windows): ReadonlyArray<string> | null =>
      windows.map((summary) => summary.windowId),
    )
    .catch(() => null);
  void windowIds.then((ids) => {
    if (isCancelled()) return;
    settleTracySurfaceAdoption(ids !== null && ids[0] === bridge.windowId);
    if (ids !== null) {
      forgetClosedTracySurfaceWindows(surfaceRecords, new Set(ids));
    }
  });

  const initialize = async (): Promise<void> => {
    const capabilities = await bridge.perWindowState.capabilities?.().catch(
      () => undefined,
    );
    if (isCancelled()) return;
    if (
      unbindDraftTopology === null &&
      capabilities?.features.includes("landing-draft-reference-move-v1") ===
        true &&
      exposesDraftReferences
    ) {
      referenceMode = true;
      unbindDraftTopology = bindDesktopDraftTopology(bridge, applyNewestSnapshot);
    }
    if (capabilities !== undefined) finishAttachNegotiation?.();
    try {
      const snapshot = await bridge.perWindowState.get();
      if (isCancelled()) return;
      await applyNewestSnapshot(snapshot);
      verification = await verifyDesktopTabsCompatibility(
        bridge,
        capabilities,
        () => latest?.revision ?? 0,
      );
      await applyNewestSnapshot(latest ?? snapshot);
    } catch (error) {
      if (isCancelled()) return;
      appLogger.error("[windows-bridge] per-window snapshot hydration failed", {}, error);
      if (!referenceMode && latest?.draftTopology === undefined) {
        configureDesktopTabsAuthority(false);
        completeHydration();
      }
    }
  };

  const refresh = (): void => {
    if (isCancelled()) return;
    if (verification !== null) {
      void bridge.perWindowState.get().then(applyNewestSnapshot).catch((error: unknown) => {
        appLogger.warn("[windows-bridge] per-window refresh failed", {
          error: describeLogError(error),
        });
      });
    } else if (initialization === null) {
      initialization = initialize().finally(() => {
        initialization = null;
      });
    }
  };
  window.addEventListener("focus", refresh);
  refresh();

  return () => {
    lifecycle.cancelled = true;
    uninstallCrossWindowVisibility();
    uninstallDesktopBackgroundRendering();
    uninstallDesktopWindowVisibility();
    perWindowSubscription.dispose();
    unbindDraftTopology?.();
    finishAttachNegotiation?.();
    window.removeEventListener("focus", refresh);
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", flushProjection);
      window.removeEventListener("beforeunload", flushProjection);
    }
    flushProjection();
    projectionBridge.dispose();
    clearDesktopTabsPersistence();
    clearDesktopWindowsBridge();
  };
}

async function verifyDesktopTabsCompatibility(
  bridge: DesktopWindowsBridge,
  capabilities: DesktopPerWindowStateCapabilities | undefined,
  minimumRevision: () => number,
): Promise<DesktopTabsVerification> {
  if (capabilities === undefined || !isDesktopTabsCapabilitySupported(capabilities)) {
    return { supported: false, acknowledgedRevision: null };
  }
  try {
    const acknowledgement = await bridge.perWindowState.update({});
    const supported =
      acknowledgement !== undefined &&
      Number.isSafeInteger(acknowledgement.revision) &&
      acknowledgement.revision > minimumRevision() &&
      isDesktopTabsCapabilitySupported(acknowledgement.capabilities);
    return {
      supported,
      acknowledgedRevision: supported ? acknowledgement.revision : null,
    };
  } catch (error) {
    appLogger.warn("[windows-bridge] desktop tab persistence unavailable", {
      error: error instanceof Error ? error.message : "unknown error",
    });
    return { supported: false, acknowledgedRevision: null };
  }
}

function clearDesktopWindowsBridge(): void {
  setEpicCanvasDesktopProjectionBridge(null);
  setLandingDraftDesktopProjectionBridge(null);
  setDesktopEpicOwnershipBridge(null);
  setActiveDesktopPerWindowProjectionBridge(null);
}

async function applyDesktopDraftTopology(
  topology: DesktopWindowDraftTopology,
  imageAdoptions: Map<string, Promise<void>>,
  isCurrent: () => boolean,
): Promise<boolean> {
  const references = topology.references.map(toCanonicalLandingDraftReference);
  for (const ref of topology.references) {
    const { moveToken } = ref;
    if (moveToken === null) continue;
    let adoption = imageAdoptions.get(moveToken);
    if (adoption === undefined) {
      const current = await readCanonicalLandingDraft(
        toCanonicalLandingDraftReference(ref),
      );
      if (!isCurrent() || current.kind === "unavailable") return false;
      if (current.kind !== "live") continue;
      adoption = adoptDraftImageHandoff(
        { draftId: ref.slotId, moveToken },
        current.manifest.digests,
      ).catch((error: unknown) => {
        imageAdoptions.delete(moveToken);
        throw error;
      });
      imageAdoptions.set(moveToken, adoption);
    }
    await adoption;
    if (!isCurrent()) return false;
  }
  const applied = await applyCanonicalLandingDraftAliases(
    { references, activeDraftId: topology.activeDraftId },
    isCurrent,
  );
  return applied.kind === "applied";
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

// `requestOpenDraftInNewWindow` is intentionally NOT listed: it is optional and
// capability-probed at its call site (`use-draft-open-in-new-window`), for the
// same skew reason as `perWindowState.clear` below - requiring it would fail
// the whole bridge guard against a preload built before draft moves existed.
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
