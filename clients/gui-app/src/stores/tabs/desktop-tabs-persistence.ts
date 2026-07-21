import type {
  DesktopJsonValue,
  DesktopPerWindowSnapshot,
  DesktopPerWindowStateCapabilities,
  DesktopPerWindowStateUpdateAcknowledgement,
  DesktopWindowsBridge,
} from "@/lib/windows/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  createLayoutItem,
  emptySystemTabs,
  emptyTabStripLayout,
  findStripItemForRef,
  flattenLayoutRefs,
  focusLayoutRef,
  repairLayout,
  tabItemId,
  type PersistedTabStripLayout,
  type SplitSide,
  type StripItem,
} from "@/stores/tabs/layout";
import {
  discardLegacyTabsSourceActiveSelection,
  migrateTabsPersistedState,
  setTabsLocalPersistenceEnabled,
  useTabsStore,
} from "@/stores/tabs/store";
import { isRegisteredTabKind } from "@/stores/tabs/registry";
import { setTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import type { SystemTab, TabRef } from "@/stores/tabs/types";

const DEBOUNCE_MS = 100;
const SETTINGS_PATHS = new Set([
  "agents",
  "appearance",
  "diagnostics",
  "general",
  "host",
  "keybindings",
  "notifications",
  "providers",
  "service",
  "shell",
  "worktrees",
]);

interface DesktopTabsPersistenceController {
  setActiveRoute(route: string): void;
  flush(): Promise<DesktopPerWindowStateUpdateAcknowledgement>;
  canApplySnapshot(snapshot: DesktopPerWindowSnapshot): boolean;
  commitAppliedSnapshot(snapshot: DesktopPerWindowSnapshot): void;
  dispose(): void;
}

type DesktopTabsPersistenceBridge = Pick<
  DesktopWindowsBridge,
  "perWindowState"
>;

interface DesktopTabsHydration {
  readonly route: string;
  readonly revision: number;
}

let activeController: DesktopTabsPersistenceController | null = null;
let pendingRestoredRoute: string | null = null;

export function isDesktopTabsCapabilitySupported(
  capabilities: DesktopPerWindowStateCapabilities,
): boolean {
  return (
    capabilities.schemaVersion >= 2 &&
    capabilities.features.includes("tab-strip-layout-v2") &&
    capabilities.features.includes("active-route-v1")
  );
}

/** Browser mode permits splits and retains its own versioned local writer. */
export function configureBrowserTabsPersistence(): void {
  setTabSplitCompatibility(true);
  setTabsLocalPersistenceEnabled(true);
}

/** Only a successfully negotiated desktop authority disables the local writer. */
export function configureDesktopTabsAuthority(supported: boolean): void {
  setTabSplitCompatibility(supported);
  setTabsLocalPersistenceEnabled(!supported);
}

export function hydrateDesktopTabs(
  snapshot: DesktopPerWindowSnapshot,
  compatible: boolean,
  legacyHistoryRoute: string | null,
): DesktopTabsHydration {
  // Desktop always chooses a per-window snapshot layout or per-window legacy
  // reconstruction. A browser-local v1 marker is never allowed to select
  // focus after either desktop authority path wins.
  discardLegacyTabsSourceActiveSelection();
  const layout =
    compatible && hasPersistedV2Layout(snapshot.tabStripLayout)
      ? sanitizeDesktopLayout(
          migrateTabsPersistedState(snapshot.tabStripLayout),
        )
      : legacyDesktopLayout(snapshot, legacyHistoryRoute);
  tabCommandCoordinator.restoreHydratedLayout(layout);
  const restoredRoute = restoreRoute(layout, snapshot.activeRoute ?? null);
  pendingRestoredRoute = restoredRoute;
  return { route: restoredRoute, revision: snapshot.revision ?? 0 };
}

export function consumeDesktopRestoredRoute(): string | null {
  const route = pendingRestoredRoute;
  pendingRestoredRoute = null;
  return route;
}

export function installDesktopTabsPersistence(
  bridge: DesktopTabsPersistenceBridge,
  initialRevision: number,
): void {
  activeController?.dispose();
  activeController = createDesktopTabsPersistenceController(
    bridge,
    initialRevision,
  );
}

export function clearDesktopTabsPersistence(): void {
  activeController?.dispose();
  activeController = null;
  pendingRestoredRoute = null;
}

export function updateDesktopTabsActiveRoute(route: string): void {
  activeController?.setActiveRoute(route);
}

export function flushDesktopTabsPersistence(): Promise<DesktopPerWindowStateUpdateAcknowledgement> {
  if (activeController === null) {
    return Promise.reject(
      new Error("Desktop tab persistence is unavailable for this window"),
    );
  }
  return activeController.flush();
}

/**
 * Best-effort lifecycle drain. Unlike the T10 move barrier above, an absent
 * controller means this renderer never negotiated tabs authority, so teardown
 * has nothing to wait for. A live controller still exposes its real failure to
 * the caller after it has drained its pending debounce.
 */
export function drainDesktopTabsPersistence(): Promise<void> {
  if (activeController === null) return Promise.resolve();
  return activeController.flush().then(() => undefined);
}

export function shouldApplyDesktopTabsSnapshot(
  snapshot: DesktopPerWindowSnapshot,
): boolean {
  return activeController?.canApplySnapshot(snapshot) ?? false;
}

/** Records a main snapshot only after the renderer has actually applied it. */
export function commitAppliedDesktopTabsSnapshot(
  snapshot: DesktopPerWindowSnapshot,
): void {
  activeController?.commitAppliedSnapshot(snapshot);
}

function createDesktopTabsPersistenceController(
  bridge: DesktopTabsPersistenceBridge,
  initialRevision: number,
): DesktopTabsPersistenceController {
  let activeRoute: string | null = null;
  let latestSequence = 0;
  let acknowledgedSequence = 0;
  // One floor spans negotiated handshake revisions, durable local write acks,
  // and main snapshots actually applied to the local layout. The public move
  // barrier only accepts an acknowledgement strictly above this floor.
  let revisionFloor = initialRevision;
  let pending = false;
  let timer: Parameters<typeof clearTimeout>[0] | null = null;
  let disposed = false;
  let failed = false;
  let writeChain: Promise<DesktopPerWindowStateUpdateAcknowledgement | null> =
    Promise.resolve(null);

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (
      disposed ||
      failed ||
      !isProjectionCoherent(activeRoute, currentLayout())
    ) {
      return;
    }
    pending = true;
    latestSequence += 1;
    clearTimer();
    timer = setTimeout(() => {
      void flush().catch(() => undefined);
    }, DEBOUNCE_MS);
  };

  const flush = (): Promise<DesktopPerWindowStateUpdateAcknowledgement> => {
    clearTimer();
    if (disposed) {
      return Promise.reject(
        new Error("Desktop tab persistence controller was disposed"),
      );
    }
    if (failed) {
      return Promise.reject(
        new Error("Desktop tab persistence is disabled after a failed write"),
      );
    }
    if (!pending) {
      return writeChain.then((acknowledgement) => {
        if (acknowledgement === null) {
          throw new Error("No durable desktop tab projection is available");
        }
        return acknowledgement;
      });
    }
    pending = false;
    const sequence = latestSequence;
    const route = activeRoute;
    const layout = currentLayout();
    if (!isProjectionCoherent(route, layout)) {
      return Promise.reject(
        new Error("Desktop tab projection lost route/layout coherence"),
      );
    }
    const projection = desktopLayoutJson(layout);
    const write = writeChain
      .catch(() => null)
      .then(async () => {
        const acknowledgement = await bridge.perWindowState.update({
          tabStripLayout: projection,
          activeRoute: route,
        });
        if (!isAcknowledgement(acknowledgement)) {
          throw new Error(
            "Desktop did not acknowledge a durable tab projection",
          );
        }
        if (acknowledgement.revision <= revisionFloor) {
          throw new Error(
            "Desktop acknowledged a stale tab projection revision",
          );
        }
        revisionFloor = acknowledgement.revision;
        acknowledgedSequence = Math.max(acknowledgedSequence, sequence);
        return acknowledgement;
      });
    writeChain = write;
    return write.catch((error: unknown) => {
      failed = true;
      clearTimer();
      configureDesktopTabsAuthority(false);
      throw error;
    });
  };

  const unsubscribe = useTabsStore.subscribe((state, previous) => {
    if (
      state.items !== previous.items ||
      state.activeItemId !== previous.activeItemId ||
      state.systemTabs !== previous.systemTabs
    ) {
      schedule();
    }
  });

  return {
    setActiveRoute: (route) => {
      if (!isAppRelativeRoute(route)) return;
      activeRoute = route;
      schedule();
    },
    flush,
    canApplySnapshot: (snapshot) =>
      (snapshot.revision ?? 0) > revisionFloor &&
      latestSequence === acknowledgedSequence,
    commitAppliedSnapshot: (snapshot) => {
      const revision = snapshot.revision ?? 0;
      if (revision <= revisionFloor) return;
      revisionFloor = revision;
    },
    dispose: () => {
      disposed = true;
      clearTimer();
      unsubscribe();
    },
  };
}

function hasPersistedV2Layout(
  value: DesktopJsonValue | null | undefined,
): boolean {
  return (
    isRecord(value) &&
    value.version === 2 &&
    Array.isArray(value.items) &&
    isRecord(value.systemTabs)
  );
}

function isProjectionCoherent(
  route: string | null,
  layout: PersistedTabStripLayout,
): boolean {
  if (route === null) return false;
  const ref = routeRef(routePath(route));
  if (ref === null)
    return layout.items.length === 0 && routePath(route) === "/";
  const active = layout.items.find((item) => item.id === layout.activeItemId);
  const backing = active === undefined ? null : routeBackingRef(active);
  return (
    backing !== null &&
    refKey(backing) === refKey(ref) &&
    refIsInLayout(layout, ref) &&
    routeMatchesHydratedRef(route, ref)
  );
}

function isAcknowledgement(
  value: DesktopPerWindowStateUpdateAcknowledgement | void,
): value is DesktopPerWindowStateUpdateAcknowledgement {
  return (
    value !== undefined &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    isDesktopTabsCapabilitySupported(value.capabilities)
  );
}

function currentLayout(): PersistedTabStripLayout {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  };
}

function sourceRefs(): ReadonlyArray<TabRef> {
  const canvas = useEpicCanvasStore.getState();
  const epics = canvas.openTabOrder.flatMap<TabRef>((id) =>
    canvas.tabsById[id] === undefined ? [] : [{ kind: "epic", id }],
  );
  const drafts = useLandingDraftStore
    .getState()
    .drafts.map<TabRef>((draft) => ({ kind: "draft", id: draft.id }));
  return [...epics, ...drafts];
}

function sanitizeDesktopLayout(
  persisted: PersistedTabStripLayout,
): PersistedTabStripLayout {
  const sourceKeys = new Set(sourceRefs().map(refKey));
  const missing = flattenLayoutRefs(persisted).filter(
    (ref) =>
      (ref.kind === "epic" || ref.kind === "draft") &&
      !sourceKeys.has(refKey(ref)),
  );
  const withoutMissing = missing.reduce(removeMissingRef, persisted);
  return repairLayout(withoutMissing, isRegisteredTabKind);
}

function removeMissingRef(
  layout: PersistedTabStripLayout,
  ref: TabRef,
): PersistedTabStripLayout {
  const item = findStripItemForRef(layout, ref);
  if (item === null) return layout;
  const items = layout.items.flatMap<StripItem>((candidate) => {
    if (candidate.id !== item.id) return [candidate];
    if (candidate.kind === "tab") return [];
    const survivor =
      [candidate.left, candidate.right]
        .filter(
          (side): side is Extract<SplitSide, { readonly kind: "tab" }> =>
            side.kind === "tab",
        )
        .map((side) => side.ref)
        .find((candidateRef) => refKey(candidateRef) !== refKey(ref)) ?? null;
    return survivor === null
      ? []
      : [{ kind: "tab", id: tabItemId(survivor), ref: survivor }];
  });
  const activeItemId = items.some(
    (candidate) => candidate.id === layout.activeItemId,
  )
    ? layout.activeItemId
    : (items.at(0)?.id ?? null);
  return { ...layout, items, activeItemId };
}

function legacyDesktopLayout(
  snapshot: DesktopPerWindowSnapshot,
  historyRoute: string | null,
): PersistedTabStripLayout {
  const systemTabs = legacySystemTabs(historyRoute);
  const layout = sourceRefs().reduce(createLayoutItem, {
    ...emptyTabStripLayout(),
    systemTabs,
  });
  const activeRef = legacyActiveRef(snapshot, historyRoute, systemTabs);
  return activeRef === null ? layout : focusLayoutRef(layout, activeRef);
}

function legacySystemTabs(
  route: string | null,
): PersistedTabStripLayout["systemTabs"] {
  if (routePath(route) === "/epics" || routePath(route) === "/epics/") {
    return {
      ...emptySystemTabs(),
      history: systemTab("history", "History", "/epics"),
    };
  }
  if (isSettingsRoutePath(routePath(route))) {
    return {
      ...emptySystemTabs(),
      settings: systemTab(
        "settings",
        "Settings",
        routePath(route) ?? "/settings",
      ),
    };
  }
  return emptySystemTabs();
}

function systemTab(
  kind: "history" | "settings",
  name: string,
  lastPath: string,
): SystemTab {
  return { id: kind, kind, name, lastPath };
}

function legacyActiveRef(
  snapshot: DesktopPerWindowSnapshot,
  historyRoute: string | null,
  systemTabs: PersistedTabStripLayout["systemTabs"],
): TabRef | null {
  const restoredRef = routeRef(routePath(historyRoute));
  if (restoredRef !== null && refIsRestorable(restoredRef, systemTabs)) {
    return restoredRef;
  }
  if (
    snapshot.activeTabId !== null &&
    sourceRefs().some(
      (ref) => ref.kind === "epic" && ref.id === snapshot.activeTabId,
    )
  ) {
    return { kind: "epic", id: snapshot.activeTabId };
  }
  if (
    snapshot.activeLandingDraftId !== null &&
    sourceRefs().some(
      (ref) => ref.kind === "draft" && ref.id === snapshot.activeLandingDraftId,
    )
  ) {
    return { kind: "draft", id: snapshot.activeLandingDraftId };
  }
  return null;
}

function restoreRoute(
  layout: PersistedTabStripLayout,
  activeRoute: string | null,
): string {
  const active = activeRoute === null ? null : routeRef(routePath(activeRoute));
  if (
    active !== null &&
    activeRoute !== null &&
    refIsInLayout(layout, active) &&
    routeMatchesHydratedRef(activeRoute, active)
  ) {
    return activeRoute;
  }
  const activeItem = layout.items.find(
    (item) => item.id === layout.activeItemId,
  );
  const backing = activeItem === undefined ? null : routeBackingRef(activeItem);
  if (backing !== null && refIsInLayout(layout, backing))
    return routeForRef(layout, backing);
  if (activeItem?.kind === "tab" && refIsInLayout(layout, activeItem.ref)) {
    return routeForRef(layout, activeItem.ref);
  }
  const nearest = layout.items
    .flatMap((item) =>
      item.kind === "tab" ? [item.ref] : [routeBackingRef(item)],
    )
    .find((ref): ref is TabRef => ref !== null && refIsInLayout(layout, ref));
  return nearest === undefined ? "/" : routeForRef(layout, nearest);
}

function refIsInLayout(layout: PersistedTabStripLayout, ref: TabRef): boolean {
  return findStripItemForRef(layout, ref) !== null;
}

function refIsRestorable(
  ref: TabRef,
  systemTabs: PersistedTabStripLayout["systemTabs"],
): boolean {
  if (ref.kind === "history" || ref.kind === "settings") {
    return systemTabs[ref.kind] !== null;
  }
  return sourceRefs().some((source) => refKey(source) === refKey(ref));
}

function routeBackingRef(item: StripItem): TabRef | null {
  if (item.kind === "tab") return item.ref;
  const side: SplitSide =
    item.routeBackingSide === "left" ? item.left : item.right;
  return side.kind === "tab" ? side.ref : null;
}

function routeForRef(layout: PersistedTabStripLayout, ref: TabRef): string {
  if (ref.kind === "epic") {
    const tab = useEpicCanvasStore.getState().tabsById[ref.id];
    return tab === undefined
      ? "/"
      : `/epics/${encodeURIComponent(tab.epicId)}/${encodeURIComponent(tab.tabId)}`;
  }
  if (ref.kind === "draft") return `/draft/${encodeURIComponent(ref.id)}`;
  const lastPath = layout.systemTabs[ref.kind]?.lastPath ?? null;
  if (
    lastPath !== null &&
    (ref.kind === "history"
      ? isHistoryRoutePath(routePath(lastPath))
      : isSettingsRoutePath(routePath(lastPath)))
  ) {
    return lastPath;
  }
  return ref.kind === "history" ? "/epics" : "/settings";
}

function routeRef(route: string | null): TabRef | null {
  if (route === null) return null;
  const pathname = routePath(route);
  if (pathname === "/epics" || pathname === "/epics/") {
    return { kind: "history", id: "history" };
  }
  if (isSettingsRoutePath(pathname)) {
    return { kind: "settings", id: "settings" };
  }
  const epicMatch = pathname?.match(/^\/epics\/([^/]+)\/([^/]+)\/?$/);
  if (epicMatch !== null && epicMatch !== undefined) {
    const tabId = decodeRouteSegment(epicMatch[2]);
    return tabId === null ? null : { kind: "epic", id: tabId };
  }
  const draftMatch = pathname?.match(/^\/draft\/([^/]+)\/?$/);
  if (draftMatch === null || draftMatch === undefined) return null;
  const draftId = decodeRouteSegment(draftMatch[1]);
  return draftId === null ? null : { kind: "draft", id: draftId };
}

function routeMatchesHydratedRef(route: string, ref: TabRef): boolean {
  const pathname = routePath(route);
  if (pathname === null) return false;
  if (ref.kind === "epic") {
    const match = pathname.match(/^\/epics\/([^/]+)\/([^/]+)\/?$/);
    if (match === null) return false;
    const epicId = decodeRouteSegment(match[1]);
    const tabId = decodeRouteSegment(match[2]);
    const tab = useEpicCanvasStore.getState().tabsById[ref.id];
    return tab !== undefined && tabId === ref.id && epicId === tab.epicId;
  }
  if (ref.kind === "draft")
    return pathname === `/draft/${encodeURIComponent(ref.id)}`;
  if (ref.kind === "history")
    return pathname === "/epics" || pathname === "/epics/";
  return isSettingsRoutePath(pathname);
}

function decodeRouteSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function routePath(route: string | null): string | null {
  if (route === null || !isAppRelativeRoute(route)) return null;
  const query = route.search(/[?#]/);
  return query === -1 ? route : route.slice(0, query);
}

function isHistoryRoutePath(pathname: string | null): boolean {
  return pathname === "/epics" || pathname === "/epics/";
}

function isSettingsRoutePath(pathname: string | null): boolean {
  if (pathname === "/settings" || pathname === "/settings/") return true;
  if (pathname === null || !pathname.startsWith("/settings/")) return false;
  return SETTINGS_PATHS.has(pathname.slice("/settings/".length));
}

function isAppRelativeRoute(route: string): boolean {
  return route.startsWith("/") && !route.startsWith("//");
}

function isRecord(value: DesktopJsonValue | null | undefined): value is {
  readonly [key: string]: DesktopJsonValue;
} {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refKey(ref: TabRef): string {
  return `${ref.kind}:${ref.id}`;
}

function desktopLayoutJson(layout: PersistedTabStripLayout): DesktopJsonValue {
  return {
    version: 2,
    items: layout.items.map(desktopStripItemJson),
    activeItemId: layout.activeItemId,
    systemTabs: {
      history: desktopSystemTabJson(layout.systemTabs.history),
      settings: desktopSystemTabJson(layout.systemTabs.settings),
    },
  };
}

function desktopStripItemJson(item: StripItem): DesktopJsonValue {
  if (item.kind === "tab") {
    return { kind: "tab", id: item.id, ref: desktopRefJson(item.ref) };
  }
  return {
    kind: "split",
    id: item.id,
    left: desktopSideJson(item.left),
    right: desktopSideJson(item.right),
    focusedSide: item.focusedSide,
    routeBackingSide: item.routeBackingSide,
    leftRatio: item.leftRatio,
  };
}

function desktopSideJson(side: SplitSide): DesktopJsonValue {
  if (side.kind === "empty") return { kind: "empty" };
  if (side.kind === "tab")
    return { kind: "tab", ref: desktopRefJson(side.ref) };
  return {
    kind: "unavailable",
    previousRef: desktopRefJson(side.previousRef),
    label: side.label,
  };
}

function desktopRefJson(ref: TabRef): DesktopJsonValue {
  return { kind: ref.kind, id: ref.id };
}

function desktopSystemTabJson(tab: SystemTab | null): DesktopJsonValue {
  return tab === null
    ? null
    : { id: tab.id, kind: tab.kind, name: tab.name, lastPath: tab.lastPath };
}
