import type {
  BrowserCdpResult,
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import {
  browserViewNativeTabKeyId,
  type BrowserViewNativeTabCapability,
  type BrowserViewNativeTabKey,
  type BrowserViewNativeTabStatusChange,
} from "@traycer-clients/shared/platform/browser-view";
import type {
  BrowserViewElectronTabCdpDispatch,
  BrowserViewEnsureTab,
  BrowserViewNativeTabTransfer,
} from "../browser-view/browser-view-port";
import { describeLogError, log } from "../app/logger";

type CreateElectronTabFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "createElectronTab" }
>;
type ElectronTabAcceptedFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "electronTabAccepted" }
>;
type ReleaseElectronTabFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "releaseElectronTab" }
>;
type CdpRequestFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "cdpRequest" }
>;

/**
 * The native surface this lifecycle drives, which is the `BrowserViewManager`
 * in production. Declared structurally so the suites drive the real frame flow
 * against a recording double instead of an Electron app.
 */
export interface BrowserSessionsTabPort {
  ensureTab(
    windowId: string,
    input: BrowserViewEnsureTab,
  ): Promise<BrowserViewNativeTabCapability>;
  acceptTab(input: BrowserViewNativeTabCapability): Promise<void>;
  releaseTab(input: BrowserViewNativeTabCapability): Promise<boolean>;
  dispatchElectronTabCdp(
    input: BrowserViewElectronTabCdpDispatch,
  ): Promise<BrowserCdpResult>;
  onNativeTabStatusChange(
    listener: (change: BrowserViewNativeTabStatusChange) => void,
  ): () => void;
  onNativeTabTransferred(
    listener: (transfer: BrowserViewNativeTabTransfer) => void,
  ): () => void;
}

export interface ElectronTabsOptions {
  readonly hostId: string;
  /** The window this stream belongs to; every native tab is born into it. */
  readonly windowId: string;
  readonly tabs: BrowserSessionsTabPort;
  /**
   * The live stream incarnation, read at call time rather than captured: a
   * birth outlives no connection, but the value is minted and dropped by the
   * stream around this layer. The seed's jar write is priced against it,
   * exactly as an observed frame is.
   */
  readonly connectionId: () => string | null;
  readonly sendFrame: (frame: BrowserSessionsClientFrame) => void;
  /**
   * The renderer's half of a native tab: identity only, never the seed. It is
   * what lets the renderer bind a surface to a tab main created.
   */
  readonly onTabBound: (capability: BrowserViewNativeTabCapability) => void;
  readonly onTabReleased: (capability: BrowserViewNativeTabCapability) => void;
}

interface ElectronTabBirth {
  readonly create: CreateElectronTabFrame;
  readonly settled: Promise<void>;
  provisioned: BrowserViewNativeTabCapability | null;
  accepted: ElectronTabAcceptedFrame | null;
  cancelled: boolean;
  activated: boolean;
  published: boolean;
  lastStatus: BrowserViewNativeTabStatusChange | null;
}

export interface ElectronTabs {
  handleFrame(frame: BrowserSessionsServerFrame): void;
  /**
   * Is the guest behind `tabId` on screen right now? `null` when this stream
   * owns no native guest for it, which is the ordinary answer for a tab that
   * lives on the host's own side.
   *
   * The reading is the manager's `viewed`, the same fact `electronTabState`
   * reports: a tile bound to this guest and visible.
   */
  isTabViewed(tabId: string): boolean | null;
  connect(): void;
  disconnect(): void;
  dispose(): void;
}

/**
 * A birth's position in the create -> provision -> accept lifecycle. `accepted`
 * outranks `retired` deliberately: cancelling a birth the host already accepted
 * must not make it look releasable.
 */
type ElectronTabBirthStatus =
  | "pending"
  | "provisioned"
  | "accepted"
  | "retired";

function birthStatus(birth: ElectronTabBirth): ElectronTabBirthStatus {
  const provisioned = birth.provisioned;
  if (
    provisioned !== null &&
    birth.accepted?.registrationId === provisioned.registrationId
  ) {
    return "accepted";
  }
  if (birth.cancelled) return "retired";
  return provisioned === null ? "pending" : "provisioned";
}

/** The provisioning the host accepted, or `null` while it has not. */
function acceptedProvisioning(
  birth: ElectronTabBirth,
): BrowserViewNativeTabCapability | null {
  return birthStatus(birth) === "accepted" ? birth.provisioned : null;
}

/**
 * Owns Electron births for one durable `browser.sessions` lifecycle, in the
 * MAIN process.
 *
 * This is the renderer's `electron-tabs.ts` with the IPC taken out of the
 * middle: `createElectronTab` - the frame that carries `seedStorageState` - is
 * consumed here and handed straight to the native manager, so the seed never
 * exists in a renderer heap and no IPC channel can be asked for one. The
 * renderer keeps the surface directory, fed by `tabBound` / `tabReleased`,
 * which carry identity and nothing else.
 */
export function createElectronTabs(options: ElectronTabsOptions): ElectronTabs {
  let disposed = false;
  let connected = true;
  let connectionGeneration = 0;
  const birthByRequestId = new Map<string, ElectronTabBirth>();
  const requestIdByTabKey = new Map<string, string>();
  const releaseByIncarnation = new Map<string, Promise<void>>();
  let disposeStatusSubscription: (() => void) | null = null;
  let disposeTransferSubscription: (() => void) | null = null;

  const isCurrentConnection = (generation: number): boolean =>
    !disposed && connected && generation === connectionGeneration;

  const sendCurrentTabState = (
    birth: ElectronTabBirth,
    change: BrowserViewNativeTabStatusChange,
  ): void => {
    if (!disposed && connected) sendTabState(options, birth, change);
  };

  const nativeKeyFor = (
    birth: ElectronTabBirth,
    registrationId: string,
  ): BrowserViewNativeTabCapability => ({
    hostId: options.hostId,
    sessionId: birth.create.sessionId,
    tabId: birth.create.tabId,
    registrationId,
  });

  async function releaseBirth(birth: ElectronTabBirth): Promise<void> {
    if (birth.provisioned === null) return;
    const registrationId = birth.provisioned.registrationId;
    const capability = nativeKeyFor(birth, registrationId);
    const tabKey = browserViewNativeTabKeyId(capability);
    const incarnationKey = `${tabKey}:${registrationId}`;
    const existing = releaseByIncarnation.get(incarnationKey);
    if (existing !== undefined) return existing;
    const pending = options.tabs
      .releaseTab(capability)
      .then(() => {
        options.onTabReleased(capability);
        if (birthByRequestId.get(birth.create.requestId) === birth) {
          birthByRequestId.delete(birth.create.requestId);
        }
        if (requestIdByTabKey.get(tabKey) === birth.create.requestId) {
          requestIdByTabKey.delete(tabKey);
        }
        releaseByIncarnation.delete(incarnationKey);
      })
      .catch((cause: unknown) => {
        releaseByIncarnation.delete(incarnationKey);
        throw cause;
      });
    releaseByIncarnation.set(incarnationKey, pending);
    return pending;
  }

  /**
   * Drops a birth's bookkeeping. `notifyReleased` is explicit because
   * `rollbackUnacceptedBirth` follows this with `releaseBirth`, which emits
   * `onTabReleased` itself once the tab is actually released - so notifying
   * here too sent the same `registrationId` twice on every disconnect,
   * dispose and stale-provision rollback.
   */
  const retireBirth = (
    birth: ElectronTabBirth,
    notifyReleased: boolean,
  ): void => {
    birth.cancelled = true;
    const tabKey = browserViewNativeTabKeyId({
      hostId: options.hostId,
      sessionId: birth.create.sessionId,
      tabId: birth.create.tabId,
    });
    if (birthByRequestId.get(birth.create.requestId) === birth) {
      birthByRequestId.delete(birth.create.requestId);
    }
    if (requestIdByTabKey.get(tabKey) === birth.create.requestId) {
      requestIdByTabKey.delete(tabKey);
    }
    if (notifyReleased && birth.provisioned !== null) {
      options.onTabReleased(
        nativeKeyFor(birth, birth.provisioned.registrationId),
      );
    }
  };

  function rollbackUnacceptedBirth(birth: ElectronTabBirth): void {
    if (birthStatus(birth) === "accepted") return;
    // `releaseBirth` owns the notification here: it fires after the tab is
    // genuinely gone, which is what a consumer of `tabReleased` wants.
    retireBirth(birth, false);
    void releaseBirth(birth).catch(() => undefined);
  }

  const ensureStatusSubscription = (): void => {
    if (disposeStatusSubscription !== null) return;
    disposeStatusSubscription = options.tabs.onNativeTabStatusChange(
      (change) => {
        const birth = findProvisionedBirth(
          birthByRequestId.values(),
          options.hostId,
          change.sessionId,
          change.tabId,
        );
        if (
          birth === null ||
          birth.provisioned?.registrationId !== change.registrationId
        ) {
          return;
        }
        birth.lastStatus = change;
        sendCurrentTabState(birth, change);
      },
    );
  };

  /**
   * The guest behind one of this window's births just moved to another window.
   *
   * Nothing else retires an ACCEPTED birth: the move sends no
   * `releaseElectronTab`, and `rollbackUnacceptedBirth` returns early for one.
   * Left standing it would refuse the move back (`canReplaceElectronTabBirth`
   * answers `identity_violation`) and keep answering `isTabViewed` and CDP
   * frames for a tab this window no longer owns.
   *
   * Matched on the registration id the transfer RETIRED, which is the only
   * thing that names the losing window: the destination window's own birth for
   * this tab is still `provisioned === null` inside its `ensureTab`, so it
   * cannot match, and a window that held the tab in some earlier incarnation
   * carries a different id. `notifyReleased` is true because this is the one
   * retirement with no `releaseBirth` behind it to emit for it - and that
   * notification, carrying the OLD id, is what the renderer's binding
   * directory needs to drop its entry.
   */
  const retireTransferredBirths = (
    transfer: BrowserViewNativeTabTransfer,
  ): void => {
    if (transfer.key.hostId !== options.hostId) return;
    for (const birth of Array.from(birthByRequestId.values())) {
      if (birth.cancelled) continue;
      if (birth.create.sessionId !== transfer.key.sessionId) continue;
      if (birth.create.tabId !== transfer.key.tabId) continue;
      const registrationId = birth.provisioned?.registrationId ?? null;
      if (registrationId !== transfer.previousRegistrationId) continue;
      retireBirth(birth, true);
    }
  };

  const ensureTransferSubscription = (): void => {
    if (disposeTransferSubscription !== null) return;
    disposeTransferSubscription = options.tabs.onNativeTabTransferred(
      (transfer) => {
        retireTransferredBirths(transfer);
      },
    );
  };

  const activateAcceptedBirth = (birth: ElectronTabBirth): void => {
    const provisioned = acceptedProvisioning(birth);
    if (birth.activated || provisioned === null) return;
    birth.activated = true;
    void options.tabs
      .acceptTab(nativeKeyFor(birth, provisioned.registrationId))
      .catch((cause: unknown) => {
        log.warn("[browser-sessions] electron tab activation failed", {
          error: describeLogError(cause),
          sessionId: birth.create.sessionId,
          tabId: birth.create.tabId,
        });
      });
  };

  const publishAcceptedBirth = (birth: ElectronTabBirth): void => {
    const provisioned = acceptedProvisioning(birth);
    if (birth.published || provisioned === null) return;
    birth.published = true;
    options.onTabBound(nativeKeyFor(birth, provisioned.registrationId));
  };

  const acceptCreate = (frame: CreateElectronTabFrame): Promise<void> => {
    const generation = connectionGeneration;
    const existing = birthByRequestId.get(frame.requestId);
    if (existing !== undefined) {
      if (!sameCreate(existing.create, frame)) {
        sendCreateFailure(
          options,
          frame,
          "identity_violation",
          identityMessage(frame),
        );
        return Promise.resolve();
      }
      return existing.settled;
    }

    const tabKey = browserViewNativeTabKeyId({
      hostId: options.hostId,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
    });
    const existingRequestId = requestIdByTabKey.get(tabKey);
    if (
      existingRequestId !== undefined &&
      existingRequestId !== frame.requestId
    ) {
      const previous = birthByRequestId.get(existingRequestId);
      if (!canReplaceElectronTabBirth(frame, previous)) {
        sendCreateFailure(
          options,
          frame,
          "identity_violation",
          identityMessage(frame),
        );
        return Promise.resolve();
      }
      if (previous !== undefined) retireBirth(previous, true);
    }
    ensureStatusSubscription();
    ensureTransferSubscription();

    const birth: ElectronTabBirth = {
      create: frame,
      settled: options.tabs
        .ensureTab(options.windowId, {
          hostId: options.hostId,
          sessionId: frame.sessionId,
          tabId: frame.tabId,
          requestedUrl: frame.requestedUrl,
          // Relayed verbatim: the host owns which jar the guest is born into,
          // and the seed goes to the one validated write path, which is in
          // this process either way.
          profile: frame.profile,
          seedStorageState: frame.seedStorageState,
          connectionId: options.connectionId(),
        })
        .then((provisioned) => {
          if (
            !sameNativeKey(
              provisioned,
              options.hostId,
              frame.sessionId,
              frame.tabId,
            )
          ) {
            sendCreateFailure(
              options,
              frame,
              "identity_violation",
              identityMessage(frame),
            );
            void options.tabs.releaseTab(provisioned).catch(() => undefined);
            retireBirth(birth, true);
            return;
          }
          birth.provisioned = provisioned;
          if (birth.cancelled || !isCurrentConnection(generation)) {
            rollbackUnacceptedBirth(birth);
            return;
          }
          options.sendFrame({
            kind: "electronTabProvisioned",
            hasBinaryPayload: false,
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            registrationId: provisioned.registrationId,
          });
          activateAcceptedBirth(birth);
          publishAcceptedBirth(birth);
        })
        .catch((cause: unknown) => {
          if (birth.cancelled || !isCurrentConnection(generation)) return;
          options.sendFrame(
            createFailureFrame(
              frame,
              "native_create_failed",
              cause instanceof Error ? cause.message : String(cause),
            ),
          );
          retireBirth(birth, true);
        }),
      provisioned: null,
      accepted: null,
      cancelled: false,
      activated: false,
      published: false,
      lastStatus: null,
    };
    birthByRequestId.set(frame.requestId, birth);
    requestIdByTabKey.set(tabKey, frame.requestId);
    return birth.settled;
  };

  const release = async (frame: ReleaseElectronTabFrame): Promise<void> => {
    const tabKey = browserViewNativeTabKeyId({
      hostId: options.hostId,
      sessionId: frame.sessionId,
      tabId: frame.tabId,
    });
    const createRequestId = requestIdByTabKey.get(tabKey);
    if (createRequestId === undefined) return;
    const birth = birthByRequestId.get(createRequestId);
    if (birth === undefined) return;
    await birth.settled;
    if (birth.provisioned?.registrationId !== frame.registrationId) return;
    return releaseBirth(birth);
  };

  const handleCdpFrame = (frame: CdpRequestFrame): void => {
    if (!connected || disposed) return;
    const generation = connectionGeneration;
    const birth = findProvisionedBirthByTabId(
      birthByRequestId.values(),
      frame.tabId,
    );
    if (
      birth === null ||
      birth.provisioned?.registrationId !== frame.registrationId
    ) {
      sendCdpResult(options, frame.requestId, {
        kind: frame.command.kind,
        ok: false,
        error: {
          kind: "tab_not_found",
          message: "Electron tab incarnation is not active on this desktop.",
          code: null,
        },
      });
      return;
    }
    void dispatchCdp(frame, birth).then((result) => {
      if (!isCurrentConnection(generation)) return;
      sendCdpResult(options, frame.requestId, result);
    });
  };

  async function dispatchCdp(
    request: CdpRequestFrame,
    birth: ElectronTabBirth,
  ): Promise<BrowserCdpResult> {
    try {
      return await options.tabs.dispatchElectronTabCdp({
        hostId: options.hostId,
        sessionId: birth.create.sessionId,
        tabId: birth.create.tabId,
        registrationId: request.registrationId,
        target: request.target,
        command: request.command,
      });
    } catch (cause: unknown) {
      return {
        kind: request.command.kind,
        ok: false,
        error: {
          kind: "cdp_error",
          message: cause instanceof Error ? cause.message : String(cause),
          code: null,
        },
      };
    }
  }

  const handleAccepted = (frame: ElectronTabAcceptedFrame): void => {
    const birth = birthByRequestId.get(frame.requestId);
    if (
      birth === undefined ||
      birth.create.sessionId !== frame.sessionId ||
      birth.create.tabId !== frame.tabId
    ) {
      return;
    }
    birth.accepted = frame;
    activateAcceptedBirth(birth);
    if (birth.lastStatus !== null) {
      sendCurrentTabState(birth, birth.lastStatus);
    }
    publishAcceptedBirth(birth);
  };

  const retireEveryBirth = (): void => {
    for (const birth of birthByRequestId.values()) {
      rollbackUnacceptedBirth(birth);
    }
  };

  return {
    handleFrame: (frame) => {
      switch (frame.kind) {
        case "createElectronTab":
          if (connected && !disposed) void acceptCreate(frame);
          return;
        case "releaseElectronTab":
          if (connected && !disposed) void release(frame);
          return;
        case "electronTabAccepted":
          if (connected && !disposed) handleAccepted(frame);
          return;
        case "cdpRequest":
          handleCdpFrame(frame);
          return;
        default:
          return;
      }
    },
    isTabViewed: (tabId) => {
      for (const birth of birthByRequestId.values()) {
        if (birth.create.tabId !== tabId) continue;
        if (birthStatus(birth) === "retired") continue;
        return birth.lastStatus?.viewed ?? false;
      }
      return null;
    },
    connect: () => {
      if (!disposed) connected = true;
    },
    disconnect: () => {
      connected = false;
      connectionGeneration += 1;
      retireEveryBirth();
    },
    dispose: () => {
      disposed = true;
      connected = false;
      connectionGeneration += 1;
      retireEveryBirth();
      disposeStatusSubscription?.();
      disposeStatusSubscription = null;
      disposeTransferSubscription?.();
      disposeTransferSubscription = null;
    },
  };
}

function sendTabState(
  options: ElectronTabsOptions,
  birth: ElectronTabBirth,
  change: BrowserViewNativeTabStatusChange,
): void {
  const provisioned = acceptedProvisioning(birth);
  if (provisioned === null) return;
  options.sendFrame({
    kind: "electronTabState",
    hasBinaryPayload: false,
    registrationId: provisioned.registrationId,
    sessionId: birth.create.sessionId,
    tabId: birth.create.tabId,
    url: change.url,
    title: change.title,
    status: electronTabStateStatus(change.status),
    // The manager's own reading, not an inference: `viewed` is whether a tile
    // is showing this guest right now, which is a fact of the entry (surface
    // bound and visible) rather than of a lease object on the far side of an
    // IPC boundary.
    viewed: change.viewed,
  });
}

function sendCdpResult(
  options: ElectronTabsOptions,
  requestId: string,
  result: BrowserCdpResult,
): void {
  options.sendFrame({
    kind: "cdpResult",
    hasBinaryPayload: false,
    requestId,
    result,
  });
}

function sendCreateFailure(
  options: ElectronTabsOptions,
  frame: CreateElectronTabFrame,
  code: Extract<
    BrowserSessionsClientFrame,
    { readonly kind: "electronTabCreateFailed" }
  >["code"],
  message: string,
): void {
  options.sendFrame(createFailureFrame(frame, code, message));
}

function createFailureFrame(
  frame: CreateElectronTabFrame,
  code: Extract<
    BrowserSessionsClientFrame,
    { readonly kind: "electronTabCreateFailed" }
  >["code"],
  message: string,
): Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "electronTabCreateFailed" }
> {
  return {
    kind: "electronTabCreateFailed",
    hasBinaryPayload: false,
    requestId: frame.requestId,
    sessionId: frame.sessionId,
    tabId: frame.tabId,
    code,
    message,
  };
}

function sameNativeKey(
  key: BrowserViewNativeTabKey,
  hostId: string,
  sessionId: string,
  tabId: string,
): boolean {
  return (
    key.hostId === hostId && key.sessionId === sessionId && key.tabId === tabId
  );
}

function findProvisionedBirthByTabId(
  births: Iterable<ElectronTabBirth>,
  tabId: string,
): ElectronTabBirth | null {
  for (const birth of births) {
    if (
      !birth.cancelled &&
      birth.create.tabId === tabId &&
      birth.provisioned !== null
    ) {
      return birth;
    }
  }
  return null;
}

function findProvisionedBirth(
  births: Iterable<ElectronTabBirth>,
  hostId: string,
  sessionId: string,
  tabId: string,
): ElectronTabBirth | null {
  for (const birth of births) {
    if (
      birth.provisioned !== null &&
      !birth.cancelled &&
      birth.provisioned.hostId === hostId &&
      birth.create.sessionId === sessionId &&
      birth.create.tabId === tabId
    ) {
      return birth;
    }
  }
  return null;
}

function sameCreate(
  left: CreateElectronTabFrame,
  right: CreateElectronTabFrame,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.sessionId === right.sessionId &&
    left.tabId === right.tabId &&
    left.requestedUrl === right.requestedUrl &&
    left.reason === right.reason &&
    JSON.stringify(left.seedStorageState) ===
      JSON.stringify(right.seedStorageState)
  );
}

/**
 * `move` joins `restore` as the belt for a birth that outlived the transferred
 * event that should have retired it - a window that moved a tab away still
 * remembers it, and the move back must not be refused for that. The birth
 * retirement is the load-bearing half: `retireBirth` deletes the tab key
 * outright, so a transfer this window HEARD never reaches this gate at all.
 */
function canReplaceElectronTabBirth(
  frame: CreateElectronTabFrame,
  previous: ElectronTabBirth | undefined,
): boolean {
  if (frame.reason !== "restore" && frame.reason !== "move") return false;
  return previous !== undefined && acceptedProvisioning(previous) !== null;
}

function electronTabStateStatus(
  status: BrowserViewNativeTabStatusChange["status"],
) {
  if (status === "dead") return "crashed" as const;
  if (status === "loading") return "navigating" as const;
  return "ready" as const;
}

function identityMessage(frame: CreateElectronTabFrame): string {
  return `Electron tab identity violation for request ${frame.requestId}, session ${frame.sessionId}, tab ${frame.tabId}.`;
}
