import { useSyncExternalStore } from "react";
import type {
  BrowserSessionInfo,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import { appLogger } from "@/lib/logger";
import {
  buildCdpResultFrame,
  registerAgentBrowserCdpHandler,
} from "./agent-browser-cdp-store";
import {
  decideAgentTabDisposition,
  isEpicSurfaceVisible,
  isManualPipActive,
  openAgentTabInPip,
  placeAgentElectronTile,
  trackAgentTabSurfaced,
  type AgentTabDisposition,
} from "./agent-tab-surfacing";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { browserTileNameForUrl } from "./browser-link-routing-core";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import type {
  AgentBrowserViewCdpDispatch,
  AgentBrowserViewCdpResult,
  AgentBrowserViewCdpSessionEndedChange,
  AgentBrowserViewCdpTargetAttachedChange,
  AgentBrowserViewTileHandoffChange,
} from "./desktop-agent-browser-view";
import type {
  DesktopBrowserViewBridge,
  BrowserViewDurableTabRegistration,
  BrowserViewStatusChange,
  BrowserViewTileKey,
} from "./desktop-browser-view";

interface ElectronBrowserTabBridge {
  createBackgroundTab?: DesktopBrowserViewBridge["createBackgroundTab"];
  registerDurableTab(input: BrowserViewDurableTabRegistration): Promise<void>;
  releaseDurableTab?(input: BrowserViewDurableTabRegistration): Promise<void>;
  dispatchCdp(
    input: AgentBrowserViewCdpDispatch,
  ): Promise<AgentBrowserViewCdpResult>;
  onStatusChange(handler: (change: BrowserViewStatusChange) => void): {
    dispose: () => void;
  };
  onCdpSessionEnded(
    handler: (change: AgentBrowserViewCdpSessionEndedChange) => void,
  ): { dispose: () => void };
  onCdpTargetAttached(
    handler: (change: AgentBrowserViewCdpTargetAttachedChange) => void,
  ): { dispose: () => void };
  onTileHandoff(handler: (change: AgentBrowserViewTileHandoffChange) => void): {
    dispose: () => void;
  };
  setBackgroundThrottling?: DesktopBrowserViewBridge["setBackgroundThrottling"];
  applyStorageState?: DesktopBrowserViewBridge["applyStorageState"];
}

type ElectronBrowserBackgroundTabBridge = ElectronBrowserTabBridge &
  Pick<DesktopBrowserViewBridge, "applyStorageState" | "createBackgroundTab">;

export interface ElectronBrowserTabRegistration {
  readonly epicId: string;
  readonly hostId: string;
  readonly chatId: string | null;
  readonly registrationId: string;
  readonly sessionId: string;
  readonly requestedTabId?: string | null;
  readonly initialUrl: string;
  readonly title: string | null;
  readonly tileKey: BrowserViewTileKey;
  readonly bridge: ElectronBrowserTabBridge;
  readonly onRegistered: ((tabId: string) => void) | null;
  readonly onActivatedHeadless?: ((tabId: string) => void) | null;
  readonly background?: boolean;
}

interface ElectronBrowserTabRecord extends ElectronBrowserTabRegistration {
  tabId: string | null;
  lastState: BrowserViewStatusChange | null;
  visible: boolean;
  focused: boolean;
  focusOrder: number;
  cleanup: () => void;
}

type SendFrame = (frame: BrowserSessionsClientFrame) => void;

const recordsByRegistrationKey = new Map<string, ElectronBrowserTabRecord>();
const sendFrameByEpicHost = new Map<string, SendFrame>();
const backgroundBridgeByEpicHost = new Map<
  string,
  ElectronBrowserBackgroundTabBridge
>();
/**
 * Ticket 38 step 2 (GUI side): foreground creates whose source anchor is a
 * BACKGROUND view cannot split from a source pane. The fallback opens the
 * host-minted durable id (frame.tabId) as a session-addressed tile in the
 * owning chat canvas instead; this map parks the create's requestId per
 * session until that tile's own registration settles so the ack carries
 * the right tabId.
 */
const pendingForegroundCreatesBySession = new Map<
  string,
  { readonly requestId: string; readonly startedAt: number }
>();

function sweepPendingForegroundCreates(): void {
  const now = Date.now();
  for (const [sessionId, entry] of pendingForegroundCreatesBySession) {
    if (now - entry.startedAt > 10_000) {
      pendingForegroundCreatesBySession.delete(sessionId);
    }
  }
}

const createRequestsByRegistrationKey = new Map<
  string,
  {
    readonly requestId: string;
    readonly ready: Promise<void>;
    readonly startedAt: number;
  }
>();
const pendingHandoffAcks = new Map<
  string,
  { readonly promise: Promise<void>; readonly resolve: () => void }
>();
const pendingReleases = new Map<string, number>();
const PENDING_RELEASE_TTL_MS = 60_000;
const PENDING_RELEASE_MAX = 128;
let focusOrder = 0;
const bindingListeners = new Set<() => void>();

export async function drainElectronBrowserHandoffs(): Promise<void> {
  await Promise.all(
    Array.from(pendingHandoffAcks.values(), (pending) => pending.promise),
  );
}

export function registerElectronBrowserTab(
  input: ElectronBrowserTabRegistration,
): void {
  const key = registrationKey(input.sessionId, input.registrationId);
  const existing = recordsByRegistrationKey.get(key);
  if (existing !== undefined) {
    const tileKeyChanged = !isChangeForTile(input.tileKey, existing.tileKey);
    const bridge =
      existing.background === true && input.background === true
        ? existing.bridge
        : input.bridge;
    const forwardingChanged = tileKeyChanged || bridge !== existing.bridge;
    Object.assign(existing, input, { bridge });
    if (forwardingChanged) {
      existing.cleanup();
      existing.cleanup = installDesktopForwarding(existing);
    }
    if (existing.tabId !== null) existing.onRegistered?.(existing.tabId);
    publishRegistration(existing);
    return;
  }

  const record: ElectronBrowserTabRecord = {
    ...input,
    tabId: null,
    lastState: null,
    visible: false,
    focused: false,
    focusOrder: 0,
    cleanup: () => {},
  };
  recordsByRegistrationKey.set(key, record);
  record.cleanup = installDesktopForwarding(record);
  publishRegistration(record);
}

export function updateElectronBrowserTabView(input: {
  readonly sessionId: string;
  readonly registrationId: string;
  readonly visible: boolean;
  readonly focused: boolean;
}): void {
  const record = recordsByRegistrationKey.get(
    registrationKey(input.sessionId, input.registrationId),
  );
  if (record === undefined) return;
  const records = recordsForEpicHost(record.epicId, record.hostId);
  const previousViewed = mostRecentlyFocusedVisibleRecord(records);
  const focused = input.visible && input.focused;
  if (focused && !record.focused) {
    focusOrder += 1;
    record.focusOrder = focusOrder;
  } else if (
    input.visible &&
    previousViewed === null &&
    record.focusOrder === 0
  ) {
    focusOrder += 1;
    record.focusOrder = focusOrder;
  }
  record.visible = input.visible;
  record.focused = focused;
  const nextViewed = mostRecentlyFocusedVisibleRecord(records);
  if (previousViewed === nextViewed) return;
  if (previousViewed !== null) publishState(previousViewed);
  if (nextViewed !== null) publishState(nextViewed);
}

/**
 * One sender belongs to each mounted epic stream. Records route by epic rather
 * than their optional sibling chat, so artifact-only canvases still register
 * while simultaneous epics cannot ingest each other's durable tabs.
 */
export function attachElectronBrowserTabStream(
  epicId: string,
  hostId: string,
  sendFrame: SendFrame,
): () => void {
  const key = epicHostKey(epicId, hostId);
  sendFrameByEpicHost.set(key, sendFrame);
  replayElectronBrowserTabRegistrations(epicId, hostId);
  return () => {
    if (sendFrameByEpicHost.get(key) === sendFrame) {
      sendFrameByEpicHost.delete(key);
    }
  };
}

export function attachElectronBrowserBackgroundTabRoute(
  epicId: string,
  hostId: string,
  bridge: ElectronBrowserBackgroundTabBridge,
): () => void {
  const key = epicHostKey(epicId, hostId);
  backgroundBridgeByEpicHost.set(key, bridge);
  return () => {
    if (backgroundBridgeByEpicHost.get(key) === bridge) {
      backgroundBridgeByEpicHost.delete(key);
    }
  };
}

export function replayElectronBrowserTabRegistrations(
  epicId: string,
  hostId: string,
): void {
  for (const record of recordsByRegistrationKey.values()) {
    if (record.epicId === epicId && record.hostId === hostId) {
      publishRegistration(record);
    }
  }
}

export function handleElectronBrowserTabFrame(
  frame: BrowserSessionsServerFrame,
  ctx?: { readonly chatId?: string | null },
): boolean {
  if (frame.kind === "actionAck") {
    const pending = pendingHandoffAcks.get(frame.requestId);
    if (pending === undefined) return false;
    pendingHandoffAcks.delete(frame.requestId);
    pending.resolve();
    return true;
  }
  if (frame.kind === "createElectronTab") {
    return handleCreateElectronTab(frame, ctx);
  }
  if (frame.kind === "releaseElectronTab") {
    releaseElectronTab(frame);
    return true;
  }
  if (frame.kind === "electronTabRegistrationFailed") {
    handleElectronTabRegistrationFailed(frame);
    return true;
  }
  if (frame.kind !== "electronTabRegistered") return false;
  const record = recordsByRegistrationKey.get(
    registrationKey(frame.sessionId, frame.registrationId),
  );
  if (record === undefined) return true;
  appLogger.info("Electron background tab create stage", {
    event: "electron_tab_create",
    stage: "registration_received",
    outcome: "ok",
    requestId: frame.requestId,
    registrationId: frame.registrationId,
    sessionId: frame.sessionId,
    tabId: frame.tabId,
    durationMs: 0,
  });
  record.tabId = frame.tabId;
  notifyBindingListeners();
  const parkedForegroundCreate = pendingForegroundCreatesBySession.get(
    frame.sessionId,
  );
  if (
    parkedForegroundCreate !== undefined &&
    frame.tabId !== null
  ) {
    pendingForegroundCreatesBySession.delete(frame.sessionId);
    // The host activated this tab's record before replying, so its
    // step-3 create-gate will accept this ack.
    sendForRecord(record, {
      kind: "electronTabCreated",
      hasBinaryPayload: false,
      requestId: parkedForegroundCreate.requestId,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
      reason: null,
    });
  }
  const key = registrationKey(frame.sessionId, frame.registrationId);
  const createRequest = createRequestsByRegistrationKey.get(key);
  const durableStartedAt = Date.now();
  const registerDurableTab = (): Promise<void> =>
    record.bridge.registerDurableTab({
      ...record.tileKey,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
    });
  const durableRegistration =
    createRequest === undefined
      ? registerDurableTab()
      : createRequest.ready.then(registerDurableTab);
  void durableRegistration.then(
    () => {
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "durable_registration_settled",
        outcome: "ok",
        requestId: frame.requestId,
        registrationId: frame.registrationId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        durationMs: Date.now() - durableStartedAt,
      });
    },
    (error: unknown) => {
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "durable_registration_settled",
        outcome: "failed",
        requestId: frame.requestId,
        registrationId: frame.registrationId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        durationMs: Date.now() - durableStartedAt,
        cause: error instanceof Error ? error.name : typeof error,
      });
    },
  );
  if (consumePendingRelease(frame.sessionId, frame.tabId)) {
    deleteRecord(record);
    const releaseDurableTab = record.bridge.releaseDurableTab?.bind(
      record.bridge,
    );
    if (releaseDurableTab !== undefined) {
      void durableRegistration
        .then(() =>
          releaseDurableTab({
            ...record.tileKey,
            sessionId: frame.sessionId,
            tabId: frame.tabId,
          }),
        )
        .catch(ignoreRegistrationError);
    } else {
      void durableRegistration.catch(ignoreRegistrationError);
    }
    createRequestsByRegistrationKey.delete(
      registrationKey(frame.sessionId, frame.registrationId),
    );
    return true;
  }
  void durableRegistration.catch(ignoreRegistrationError);
  record.onRegistered?.(frame.tabId);
  publishState(record);
  if (createRequest !== undefined) {
    void durableRegistration.then(() => {
      if (createRequestsByRegistrationKey.get(key) !== createRequest) return;
      createRequestsByRegistrationKey.delete(key);
      const sent = sendForRecord(record, {
        kind: "electronTabCreated",
        hasBinaryPayload: false,
        requestId: createRequest.requestId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        reason: null,
      });
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "ack_sent",
        outcome: sent ? "ok" : "route-missing",
        requestId: createRequest.requestId,
        registrationId: frame.registrationId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        durationMs: Date.now() - createRequest.startedAt,
      });
    }, (error: unknown) => {
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "ack_blocked",
        outcome: "failed",
        requestId: createRequest.requestId,
        registrationId: frame.registrationId,
        sessionId: frame.sessionId,
        tabId: frame.tabId,
        durationMs: Date.now() - createRequest.startedAt,
        cause: error instanceof Error ? error.name : typeof error,
      });
    });
  }
  return true;
}

function releaseElectronTab(
  frame: Extract<BrowserSessionsServerFrame, { kind: "releaseElectronTab" }>,
): void {
  const record = findElectronBrowserTabRecord(
    frame.sessionId,
    frame.tabId,
    undefined,
  );
  if (record === undefined) {
    retainPendingRelease(frame.sessionId, frame.tabId);
    return;
  }
  createRequestsByRegistrationKey.delete(
    registrationKey(record.sessionId, record.registrationId),
  );
  appLogger.info("Electron browser tab release applied", {
    event: "electron_tab_release",
    action: "direct",
    sessionId: frame.sessionId,
    tabId: frame.tabId,
  });
  deleteRecord(record);
  if (record.bridge.releaseDurableTab === undefined) return;
  void record.bridge
    .releaseDurableTab({
      ...record.tileKey,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
    })
    .catch(ignoreRegistrationError);
}

function handleElectronTabRegistrationFailed(
  frame: Extract<
    BrowserSessionsServerFrame,
    { kind: "electronTabRegistrationFailed" }
  >,
): void {
  const record = recordsByRegistrationKey.get(
    registrationKey(frame.sessionId, frame.registrationId),
  );
  createRequestsByRegistrationKey.delete(
    registrationKey(frame.sessionId, frame.registrationId),
  );
  if (record?.background === true) {
    appLogger.info("Electron background tab lost registration", {
      event: "electron_typed_loss_release",
      action: "release",
      sessionId: frame.sessionId,
      tabId: frame.tabId,
      registrationId: frame.registrationId,
    });
    deleteRecord(record);
    if (record.bridge.releaseDurableTab !== undefined) {
      void record.bridge
        .releaseDurableTab({
          ...record.tileKey,
          sessionId: frame.sessionId,
          tabId: frame.tabId,
        })
        .catch(ignoreRegistrationError);
    }
  }
  record?.onActivatedHeadless?.(frame.tabId);
}

/**
 * Ticket 38 step 2 - the ONLY foreground path. The host mints the durable
 * tab id and carries it on the frame; identity is independent of how the
 * view is presented. The sibling opens as a session-addressed tile in the
 * requesting chat's canvas (the same mechanism as the browser sidebar),
 * and its own registration carries requestedTabId back so the host's
 * provisioning record activates and the parked create request acks with
 * the real id. Precondition failures ack null with a precise reason
 * instead of falling into any alternate creation mechanism.
 */
function handleCreateElectronTab(
  frame: Extract<BrowserSessionsServerFrame, { kind: "createElectronTab" }>,
  ctx?: { readonly chatId?: string | null },
): boolean {
  if (frame.background === true) {
    return handleBackgroundElectronTabCreate(frame);
  }

  const anchorRecord =
    findElectronBrowserTabBinding(frame.sessionId, frame.sourceTabId) ??
    (typeof frame.tabId === "string"
      ? findElectronBrowserTabBinding(frame.sessionId, frame.tabId)
      : null);

  const fail = (reason: string): boolean => {
    if (anchorRecord !== null) {
      sendForRecord(anchorRecord, {
        kind: "electronTabCreated",
        hasBinaryPayload: false,
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        tabId: null,
        reason,
      });
      return true;
    }
    // No channel to answer on; upstream's honest fallback owns it.
    return false;
  };

  if (typeof frame.tabId !== "string") {
    return fail(
      "Host sent no durable tab id on createElectronTab (pre-mint contract violation).",
    );
  }
  sweepPendingForegroundCreates();
  const existing = findElectronBrowserTabBinding(
    frame.sessionId,
    frame.tabId,
  );
  if (existing !== null && existing.requestedTabId === frame.tabId) {
    // Retry after a partially-settled attempt: this tab is live here.
    sendForRecord(existing, {
      kind: "electronTabCreated",
      hasBinaryPayload: false,
      requestId: frame.requestId,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
      reason: null,
    });
    return true;
  }

  // Presentation preference (pip / tile / off), applied by the GUI only -
  // identity was already settled by the host's mint on the frame.
  const disposition: AgentTabDisposition =
    frame.epicId === undefined || frame.hostId === undefined
      ? { action: "tile", suppressReason: null }
      : decideAgentTabDisposition({
          mode: useSettingsStore.getState().agentTabSurfacingMode,
          epicVisible: isEpicSurfaceVisible(frame.epicId),
          manualPipActive: isManualPipActive(frame.epicId),
        });
  trackAgentTabSurfaced(disposition, "electron-create");

  const epicId = frame.epicId;
  const hostId = frame.hostId;
  if (
    disposition.action !== "tile" &&
    epicId !== undefined &&
    hostId !== undefined &&
    createHiddenElectronTab(frame, {
      // Claim the host-minted id directly - no placeholder runtime key or
      // post-registration rekey needed under the pre-mint contract.
      requestedTabId: frame.tabId,
      onRegistered:
        disposition.action === "float"
          ? (registeredTabId) =>
              openAgentTabInPip({
                epicId,
                hostId,
                sessionId: frame.sessionId,
                tabId: registeredTabId,
              })
          : null,
    })
  ) {
    return true;
  }

  // Visible placement. Preferred shape: group into the session's existing
  // pane when one is reachable from the anchor record.
  const sourceRecord =
    findElectronBrowserTabBinding(frame.sessionId, frame.sourceTabId);
  const viewTabId =
    ctx?.chatId != null ? findViewTabForChat(ctx.chatId) : undefined;
  if (
    sourceRecord !== null &&
    placeAgentElectronTile({
      viewTabId: sourceRecord.tileKey.viewTabId,
      anchorPaneId: sourceRecord.tileKey.paneId,
      hostId: sourceRecord.hostId,
      sessionId: frame.sessionId,
      url: frame.url,
      runtime: sourceRecord.background === true ? "primary" : "isolated",
    }) !== null
  ) {
    return true;
  }

  // Otherwise: session-addressed viewport into the requesting chat's canvas
  // (the same mechanism as the browser sidebar's open). The parked create
  // acks once this tile's own registration settles.
  if (viewTabId !== undefined) {
    pendingForegroundCreatesBySession.set(frame.sessionId, {
      requestId: frame.requestId,
      startedAt: Date.now(),
    });
    useEpicCanvasStore
      .getState()
      .prepareOpenTileInTabFocusTarget(
        viewTabId,
        makeBrowserSessionTileRef({
          name: browserTileNameForUrl(frame.url),
          hostId: frame.hostId ?? "",
          sessionId: frame.sessionId,
          tabId: frame.tabId,
        }),
      );
    return true;
  }
  if (viewTabId !== undefined) {
    pendingForegroundCreatesBySession.set(frame.sessionId, {
      requestId: frame.requestId,
      startedAt: Date.now(),
    });
    useEpicCanvasStore
      .getState()
      .prepareOpenTileInTabFocusTarget(
        viewTabId,
        makeBrowserSessionTileRef({
          name: browserTileNameForUrl(frame.url),
          hostId: frame.hostId ?? "",
          sessionId: frame.sessionId,
          tabId: frame.tabId,
        }),
      );
    return true;
  }
  return fail("No epic-canvas is hosting this chat.");
}

/** The epic-canvas view tab whose canvas contains the chat node. */
function findViewTabForChat(chatId: string): string | undefined {
  const state = useEpicCanvasStore.getState();
  for (const [viewTabId, canvas] of Object.entries(state.canvasByTabId)) {
    if (canvas === undefined) continue;
    for (const tile of Object.values(canvas.tilesByInstanceId)) {
      if ((tile as { id?: unknown }).id === chatId) return viewTabId;
    }
  }
  return undefined;
}

function handleBackgroundElectronTabCreate(
  frame: Extract<BrowserSessionsServerFrame, { kind: "createElectronTab" }>,
): boolean {
  return createHiddenElectronTab(frame, {
    requestedTabId: frame.sourceTabId,
    onRegistered: null,
  });
}

/**
 * Creates a hidden/off-screen BrowserView for a `createElectronTab` request
 * without ever opening a canvas pane. Two callers:
 *
 * - background placement frames bind `requestedTabId` to their pre-minted
 *   source tab id;
 * - suppressed agent foreground creates ("Off"/PiP surfacing) must register
 *   with `requestedTabId: null` — only background creates may bind a source
 *   tab id, and the host mints the durable tab id at registration — so their
 *   desktop entry starts under a client-minted placeholder runtime key until
 *   `registerDurableTab` rekeys it onto the minted id. `onRegistered` then
 *   receives that id (the PiP pipeline arms capture against it).
 */
function createHiddenElectronTab(
  frame: Extract<BrowserSessionsServerFrame, { kind: "createElectronTab" }>,
  plan: {
    readonly requestedTabId: string | null;
    readonly onRegistered: ((tabId: string) => void) | null;
  },
): boolean {
  const epicId = frame.epicId;
  const hostId = frame.hostId;
  if (epicId === undefined || hostId === undefined) return false;
  const bridge = backgroundBridgeByEpicHost.get(epicHostKey(epicId, hostId));
  if (bridge?.createBackgroundTab === undefined) return false;
  const createBackgroundTab = bridge.createBackgroundTab.bind(bridge);
  const registrationId = crypto.randomUUID();
  const runtimeTabId = plan.requestedTabId ?? `pending-${registrationId}`;
  const tileKey: BrowserViewTileKey = {
    viewTabId: "background",
    paneId: "background",
    tileInstanceId: crypto.randomUUID(),
    pageSessionId: registrationId,
  };
  const key = registrationKey(frame.sessionId, registrationId);
  const startedAt = Date.now();
  appLogger.info("Electron background tab create stage", {
    event: "electron_tab_create",
    stage: "frame_received",
    outcome: "ok",
    requestId: frame.requestId,
    registrationId,
    sessionId: frame.sessionId,
    tabId: runtimeTabId,
    durationMs: 0,
  });
  const seed =
    frame.seedStorageState === undefined || frame.seedStorageState === null
      ? Promise.resolve()
      : bridge.applyStorageState({
          storageState: frame.seedStorageState,
          sessionId: frame.sessionId,
          tabId: frame.sourceTabId,
          purpose: "primary-profile-seed",
        });
  appLogger.info("Electron background tab create stage", {
    event: "electron_tab_create",
    stage: "seed_started",
    outcome: "started",
    requestId: frame.requestId,
    registrationId,
    sessionId: frame.sessionId,
    tabId: runtimeTabId,
    durationMs: 0,
  });
  void seed
    .then(() => {
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "seed_settled",
        outcome: "ok",
        requestId: frame.requestId,
        registrationId,
        sessionId: frame.sessionId,
        tabId: runtimeTabId,
        durationMs: Date.now() - startedAt,
      });
      const creationStartedAt = Date.now();
      const creation = createBackgroundTab({
        ...tileKey,
        sessionId: frame.sessionId,
        tabId: runtimeTabId,
        url: frame.url,
        seedStorageState: frame.seedStorageState ?? null,
      });
      void creation.then(
        () => {
          appLogger.info("Electron background tab create stage", {
            event: "electron_tab_create",
            stage: "desktop_create_settled",
            outcome: "ok",
            requestId: frame.requestId,
            registrationId,
            sessionId: frame.sessionId,
            tabId: runtimeTabId,
            durationMs: Date.now() - creationStartedAt,
          });
        },
        (error: unknown) => {
          appLogger.info("Electron background tab create stage", {
            event: "electron_tab_create",
            stage: "desktop_create_settled",
            outcome: "failed",
            requestId: frame.requestId,
            registrationId,
            sessionId: frame.sessionId,
            tabId: runtimeTabId,
            durationMs: Date.now() - creationStartedAt,
            cause: error instanceof Error ? error.name : typeof error,
          });
        },
      );
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "desktop_create_invoked",
        outcome: "started",
        requestId: frame.requestId,
        registrationId,
        sessionId: frame.sessionId,
        tabId: runtimeTabId,
        durationMs: Date.now() - startedAt,
      });
      createRequestsByRegistrationKey.set(key, {
        requestId: frame.requestId,
        ready: creation,
        startedAt,
      });
      registerElectronBrowserTab({
        epicId,
        hostId,
        chatId: null,
        registrationId,
        sessionId: frame.sessionId,
        requestedTabId: plan.requestedTabId,
        initialUrl: frame.url,
        title: null,
        tileKey,
        bridge,
        onRegistered: plan.onRegistered,
        background: true,
      });
      appLogger.info("Electron background tab create stage", {
        event: "electron_tab_create",
        stage: "record_registered",
        outcome: "ok",
        requestId: frame.requestId,
        registrationId,
        sessionId: frame.sessionId,
        tabId: runtimeTabId,
        durationMs: Date.now() - startedAt,
      });
      return creation;
    })
    .catch((error: unknown) => {
      createRequestsByRegistrationKey.delete(key);
      const record = recordsByRegistrationKey.get(key);
      if (record !== undefined) deleteRecord(record);
      void bridge
        .releaseDurableTab?.({
          ...tileKey,
          sessionId: frame.sessionId,
          tabId: runtimeTabId,
        })
        .catch(ignoreRegistrationError);
      sendFrameByEpicHost.get(epicHostKey(epicId, hostId))?.({
        kind: "electronTabCreated",
        hasBinaryPayload: false,
        requestId: frame.requestId,
        sessionId: frame.sessionId,
        tabId: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
}

export function syncElectronBrowserTabDrivers(
  session: BrowserSessionInfo,
): void {
  for (const tab of session.tabs) {
    const record = findElectronBrowserTabBindingOnHost(
      session.sessionId,
      tab.tabId,
      session.hostId,
    );
    const setBackgroundThrottling = record?.bridge.setBackgroundThrottling;
    if (record === null || setBackgroundThrottling === undefined) continue;
    void setBackgroundThrottling({
      ...record.tileKey,
      enabled: tab.drivenBy.length === 0,
    }).catch(ignoreRegistrationError);
  }
}

function installDesktopForwarding(
  record: ElectronBrowserTabRecord,
): () => void {
  const disposeCdp = installCdpForwarder(record);
  const status = record.bridge.onStatusChange((change) => {
    const current = currentRecord(record);
    if (current === undefined || !isChangeForTile(change, current.tileKey)) {
      return;
    }
    current.lastState = change;
    publishState(current);
  });
  const cdpSessionEnded = record.bridge.onCdpSessionEnded((change) => {
    const current = currentRecord(record);
    if (current === undefined || !isChangeForTile(change, current.tileKey)) {
      return;
    }
    sendForRecord(current, {
      kind: "cdpSessionEnded",
      hasBinaryPayload: false,
      requestId: crypto.randomUUID(),
      tileInstanceId: change.tileInstanceId,
      reason: change.reason,
    });
  });
  const cdpTargetAttached = record.bridge.onCdpTargetAttached((change) => {
    const current = currentRecord(record);
    if (current === undefined || !isChangeForTile(change, current.tileKey)) {
      return;
    }
    sendForRecord(current, {
      kind: "cdpTargetAttached",
      hasBinaryPayload: false,
      requestId: crypto.randomUUID(),
      tileInstanceId: change.tileInstanceId,
      sessionId: change.sessionId,
      targetId: change.targetId,
      targetType: change.targetType,
      url: change.url,
      waitingForDebugger: change.waitingForDebugger,
    });
  });
  const tileHandoff = record.bridge.onTileHandoff((change) => {
    const current = currentRecord(record);
    if (current === undefined || !isChangeForTile(change, current.tileKey)) {
      return;
    }
    const requestId = crypto.randomUUID();
    let resolveAck: (() => void) | null = null;
    const promise = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
    pendingHandoffAcks.set(requestId, {
      promise,
      resolve: () => resolveAck?.(),
    });
    sendForRecord(current, {
      kind: "tileHandoff",
      hasBinaryPayload: false,
      requestId,
      tileInstanceId: change.tileInstanceId,
      capturedUrl: change.capturedUrl,
      capturedStorageState: jsonPayload(change.capturedStorageState),
      siblingTabs: change.siblingTabs.map((sibling) => ({
        tabId: sibling.tabId,
        url: sibling.url,
        capturedStorageState: jsonPayload(sibling.capturedStorageState),
      })),
      reason: change.reason,
    });
  });
  return () => {
    disposeCdp();
    status.dispose();
    cdpSessionEnded.dispose();
    cdpTargetAttached.dispose();
    tileHandoff.dispose();
  };
}

function installCdpForwarder(record: ElectronBrowserTabRecord): () => void {
  return registerAgentBrowserCdpHandler(
    record.tileKey.tileInstanceId,
    (request) => {
      const current = currentRecord(record);
      if (current === undefined) return;
      void current.bridge
        .dispatchCdp({
          ...current.tileKey,
          sessionId: request.sessionId,
          command: request.command,
        })
        .then((result) => {
          request.sendFrame(
            buildCdpResultFrame(
              request.requestId,
              request.tileInstanceId,
              result,
            ),
          );
        })
        .catch((error: unknown) => {
          request.sendFrame(
            buildCdpResultFrame(request.requestId, request.tileInstanceId, {
              kind: request.command.kind,
              ok: false,
              error: {
                kind: "cdp_error",
                message: error instanceof Error ? error.message : String(error),
                code: null,
              },
            }),
          );
        });
    },
  );
}

function publishRegistration(record: ElectronBrowserTabRecord): void {
  const createRequest = createRequestsByRegistrationKey.get(
    registrationKey(record.sessionId, record.registrationId),
  );
  const sent = sendForRecord(record, {
    kind: "registerElectronTab",
    hasBinaryPayload: false,
    requestId: createRequest?.requestId ?? crypto.randomUUID(),
    registrationId: record.registrationId,
    sessionId: record.sessionId,
    requestedTabId: record.requestedTabId ?? null,
    tileInstanceId: record.tileKey.tileInstanceId,
    initialUrl: record.initialUrl,
    title: record.title,
  });
  if (record.background === true) {
    appLogger.info("Electron background tab create stage", {
      event: "electron_tab_create",
      stage: "registration_sent",
      outcome: sent ? "ok" : "route-missing",
      requestId: createRequest?.requestId ?? "unavailable",
      registrationId: record.registrationId,
      sessionId: record.sessionId,
      tabId: record.requestedTabId ?? "unavailable",
      durationMs:
        createRequest === undefined ? 0 : Date.now() - createRequest.startedAt,
    });
  }
}

function publishState(record: ElectronBrowserTabRecord): void {
  if (record.tabId === null || record.lastState === null) return;
  sendForRecord(record, {
    kind: "electronTabState",
    hasBinaryPayload: false,
    requestId: crypto.randomUUID(),
    registrationId: record.registrationId,
    sessionId: record.sessionId,
    tabId: record.tabId,
    url: record.lastState.url,
    title: record.lastState.title.length > 0 ? record.lastState.title : null,
    status: sessionStatus(record.lastState),
    viewed: isViewed(record),
  });
}

function recordsForEpicHost(
  epicId: string,
  hostId: string,
): ElectronBrowserTabRecord[] {
  return [...recordsByRegistrationKey.values()].filter(
    (record) => record.epicId === epicId && record.hostId === hostId,
  );
}

function isViewed(record: ElectronBrowserTabRecord): boolean {
  return (
    mostRecentlyFocusedVisibleRecord(
      recordsForEpicHost(record.epicId, record.hostId),
    ) === record
  );
}

function mostRecentlyFocusedVisibleRecord(
  records: readonly ElectronBrowserTabRecord[],
): ElectronBrowserTabRecord | null {
  let mostRecent: ElectronBrowserTabRecord | null = null;
  for (const candidate of records) {
    if (!candidate.visible || candidate.focusOrder === 0) continue;
    if (mostRecent === null || candidate.focusOrder > mostRecent.focusOrder) {
      mostRecent = candidate;
    }
  }
  return mostRecent;
}

function sendForRecord(
  record: ElectronBrowserTabRegistration,
  frame: BrowserSessionsClientFrame,
): boolean {
  const sendFrame = sendFrameByEpicHost.get(
    epicHostKey(record.epicId, record.hostId),
  );
  if (sendFrame === undefined) return false;
  sendFrame(frame);
  return true;
}

export function findElectronBrowserTabBinding(
  sessionId: string,
  tabId: string,
): ElectronBrowserTabRegistration | null {
  return findElectronBrowserTabRecord(sessionId, tabId, undefined) ?? null;
}

export function findElectronBrowserTabBindingOnHost(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronBrowserTabRegistration | null {
  return findElectronBrowserTabRecord(sessionId, tabId, hostId) ?? null;
}

export function findElectronBrowserTabIdForTile(
  tileKey: BrowserViewTileKey,
): string | null {
  for (const record of recordsByRegistrationKey.values()) {
    if (isChangeForTile(record.tileKey, tileKey)) return record.tabId;
  }
  return null;
}

export function useElectronBrowserTabBinding(
  sessionId: string,
  tabId: string,
): ElectronBrowserTabRegistration | null {
  const registrationId = useSyncExternalStore(
    subscribeBindingChanges,
    () =>
      findElectronBrowserTabBinding(sessionId, tabId)?.registrationId ?? null,
    () => null,
  );
  return registrationId === null
    ? null
    : (recordsByRegistrationKey.get(
        registrationKey(sessionId, registrationId),
      ) ?? null);
}

export function useElectronBrowserTabBindingOnHost(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronBrowserTabRegistration | null {
  const registrationId = useSyncExternalStore(
    subscribeBindingChanges,
    () =>
      findElectronBrowserTabBindingOnHost(sessionId, tabId, hostId)
        ?.registrationId ?? null,
    () => null,
  );
  return registrationId === null
    ? null
    : (recordsByRegistrationKey.get(
        registrationKey(sessionId, registrationId),
      ) ?? null);
}

function findElectronBrowserTabRecord(
  sessionId: string,
  tabId: string,
  hostId: string | undefined,
): ElectronBrowserTabRecord | undefined {
  let found: ElectronBrowserTabRecord | undefined;
  for (const record of recordsByRegistrationKey.values()) {
    if (
      record.sessionId === sessionId &&
      record.tabId === tabId &&
      (hostId === undefined || record.hostId === hostId)
    ) {
      found = record;
    }
  }
  return found;
}

function isChangeForTile(
  change: BrowserViewTileKey,
  key: BrowserViewTileKey,
): boolean {
  return (
    change.viewTabId === key.viewTabId &&
    change.paneId === key.paneId &&
    change.tileInstanceId === key.tileInstanceId &&
    change.pageSessionId === key.pageSessionId
  );
}

function jsonPayload(
  value: unknown,
): Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "tileHandoff" }
>["capturedStorageState"] {
  return value as Extract<
    BrowserSessionsClientFrame,
    { readonly kind: "tileHandoff" }
  >["capturedStorageState"];
}

function ignoreRegistrationError(_error: unknown): void {}

function sessionStatus(
  change: BrowserViewStatusChange,
): "ready" | "navigating" | "crashed" {
  if (change.status === "dead") return "crashed";
  if (change.status === "loading") return "navigating";
  return "ready";
}

function currentRecord(
  record: ElectronBrowserTabRecord,
): ElectronBrowserTabRecord | undefined {
  return recordsByRegistrationKey.get(
    registrationKey(record.sessionId, record.registrationId),
  );
}

function registrationKey(sessionId: string, registrationId: string): string {
  return [sessionId, registrationId].join("\u001f");
}

function retainPendingRelease(sessionId: string, tabId: string): void {
  const now = Date.now();
  prunePendingReleases(now);
  const key = registrationKey(sessionId, tabId);
  pendingReleases.delete(key);
  pendingReleases.set(key, now);
  while (pendingReleases.size > PENDING_RELEASE_MAX) {
    for (const oldest of pendingReleases.keys()) {
      pendingReleases.delete(oldest);
      break;
    }
  }
  appLogger.info("Electron browser tab release tombstone created", {
    event: "electron_release_tombstone",
    action: "create",
    sessionId,
    tabId,
    pendingCount: pendingReleases.size,
  });
}

function consumePendingRelease(sessionId: string, tabId: string): boolean {
  const now = Date.now();
  prunePendingReleases(now);
  const key = registrationKey(sessionId, tabId);
  const createdAt = pendingReleases.get(key);
  if (createdAt === undefined) return false;
  pendingReleases.delete(key);
  appLogger.info("Electron browser tab release tombstone consumed", {
    event: "electron_release_tombstone",
    action: "consume",
    sessionId,
    tabId,
    ageMs: now - createdAt,
    pendingCount: pendingReleases.size,
  });
  return true;
}

function prunePendingReleases(now: number): void {
  for (const [key, createdAt] of pendingReleases) {
    if (now - createdAt <= PENDING_RELEASE_TTL_MS) break;
    pendingReleases.delete(key);
  }
}

function epicHostKey(epicId: string, hostId: string): string {
  return `${epicId}\u0000${hostId}`;
}

export function resetElectronBrowserTabStoreForTests(): void {
  for (const record of recordsByRegistrationKey.values()) record.cleanup();
  recordsByRegistrationKey.clear();
  sendFrameByEpicHost.clear();
  backgroundBridgeByEpicHost.clear();
  for (const pending of pendingHandoffAcks.values()) pending.resolve();
  pendingHandoffAcks.clear();
  createRequestsByRegistrationKey.clear();
  pendingReleases.clear();
  focusOrder = 0;
  notifyBindingListeners();
}

function deleteRecord(record: ElectronBrowserTabRecord): void {
  record.cleanup();
  recordsByRegistrationKey.delete(
    registrationKey(record.sessionId, record.registrationId),
  );
  notifyBindingListeners();
}

function subscribeBindingChanges(listener: () => void): () => void {
  bindingListeners.add(listener);
  return () => bindingListeners.delete(listener);
}

function notifyBindingListeners(): void {
  for (const listener of bindingListeners) listener();
}
