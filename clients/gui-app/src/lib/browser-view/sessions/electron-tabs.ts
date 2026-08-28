import {
  type BrowserCdpResult,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewAttachSurface,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
  BrowserViewNativeTabStatusChange,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { appLogger } from "@/lib/logger";
import { compositeKey } from "../tiles/browser-view-keys";
import { ignoreError } from "../ignore-error";
import {
  type ElectronTabSurfaceLease,
  nativeTabKey,
  publishElectronTabBinding,
  registerElectronTabHandoffAck,
  rejectOwnedElectronTabHandoffAcks,
  removeOwnedElectronTabBinding,
  removeOwnedElectronTabBindings,
  settleElectronTabHandoffAck,
} from "./electron-tab-directory";

export {
  drainElectronTabHandoffs,
  useElectronTabBindingOnHost,
} from "./electron-tab-directory";
export type {
  ElectronTabBinding,
  ElectronTabSurfaceLease,
} from "./electron-tab-directory";

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
type ActionAckFrame = Extract<
  BrowserSessionsServerFrame,
  { readonly kind: "actionAck" }
>;
interface ElectronTabsOptions {
  readonly hostId: string;
  readonly native: BrowserViewBridge | null;
  readonly sendFrame: (frame: BrowserSessionsClientFrame) => void;
}

interface ElectronTabBirth {
  readonly create: CreateElectronTabFrame;
  readonly native: BrowserViewBridge;
  readonly settled: Promise<void>;
  provisioned: BrowserViewNativeTabCapability | null;
  accepted: ElectronTabAcceptedFrame | null;
  cancelled: boolean;
  activated: boolean;
  published: boolean;
  activeSurface: {
    readonly token: symbol;
    readonly input: BrowserViewAttachSurface;
  } | null;
  surfaceMutation: Promise<void>;
  lastStatus: BrowserViewNativeTabStatusChange | null;
}

export interface ElectronTabs {
  handleFrame(frame: BrowserSessionsServerFrame): boolean;
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
 * Owns Electron births for one durable browser.sessions lifecycle. Native
 * creation settles first; host acceptance authorizes publication.
 */
export function createElectronTabs(options: ElectronTabsOptions): ElectronTabs {
  const owner = Symbol("electron-tabs");
  let disposed = false;
  let connected = true;
  let connectionGeneration = 0;
  const birthByRequestId = new Map<string, ElectronTabBirth>();
  const requestIdByTabKey = new Map<string, string>();
  const releaseByIncarnation = new Map<string, Promise<void>>();
  let disposeNativeSubscriptions: (() => void) | null = null;

  const isCurrentConnection = (generation: number): boolean =>
    !disposed && connected && generation === connectionGeneration;

  const sendOnCurrentConnection = (frame: BrowserSessionsClientFrame): void => {
    if (!disposed && connected) options.sendFrame(frame);
  };

  const rejectPendingHandoffs = (message: string): void => {
    rejectOwnedElectronTabHandoffAcks(owner, message);
  };

  const sendCurrentTabState = (
    birth: ElectronTabBirth,
    change: BrowserViewNativeTabStatusChange,
  ): void => {
    if (!disposed && connected) sendTabState(options, birth, change);
  };

  async function releaseBirth(birth: ElectronTabBirth): Promise<void> {
    if (birth.provisioned === null) return;
    const registrationId = birth.provisioned.registrationId;
    const tabKey = nativeTabKey(
      options.hostId,
      birth.create.sessionId,
      birth.create.tabId,
    );
    const incarnationKey = compositeKey(tabKey, registrationId);
    const existing = releaseByIncarnation.get(incarnationKey);
    if (existing !== undefined) return existing;
    const pending = birth.native
      .releaseTab({
        hostId: options.hostId,
        sessionId: birth.create.sessionId,
        tabId: birth.create.tabId,
        registrationId,
      })
      .then(() => {
        removeOwnedElectronTabBinding(owner, tabKey, registrationId);
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

  const retireBirth = (birth: ElectronTabBirth): void => {
    birth.cancelled = true;
    const tabKey = nativeTabKey(
      options.hostId,
      birth.create.sessionId,
      birth.create.tabId,
    );
    if (birthByRequestId.get(birth.create.requestId) === birth) {
      birthByRequestId.delete(birth.create.requestId);
    }
    if (requestIdByTabKey.get(tabKey) === birth.create.requestId) {
      requestIdByTabKey.delete(tabKey);
    }
    if (birth.provisioned !== null) {
      removeOwnedElectronTabBinding(
        owner,
        tabKey,
        birth.provisioned.registrationId,
      );
    }
  };

  function rollbackUnacceptedBirth(birth: ElectronTabBirth): void {
    if (birthStatus(birth) === "accepted") return;
    retireBirth(birth);
    void releaseBirth(birth).catch(ignoreError);
  }

  const ensureNativeSubscriptions = (native: BrowserViewBridge): void => {
    if (disposeNativeSubscriptions !== null) return;
    const statusSubscription = native.onNativeTabStatusChange((change) => {
      const birth = findProvisionedBirth(
        birthByRequestId.values(),
        change.hostId,
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
    });
    const handoffSubscription = native.onElectronTabHandoff((change) => {
      if (disposed || !connected) return;
      const birth = findProvisionedBirth(
        birthByRequestId.values(),
        change.hostId,
        change.sessionId,
        change.tabId,
      );
      if (
        birth === null ||
        birth.provisioned?.registrationId !== change.registrationId
      ) {
        return;
      }
      const requestId = crypto.randomUUID();
      registerElectronTabHandoffAck(requestId, owner);
      try {
        sendOnCurrentConnection({
          kind: "electronTabHandoff",
          hasBinaryPayload: false,
          requestId,
          sessionId: change.sessionId,
          tabId: change.tabId,
          registrationId: change.registrationId,
          capturedUrl: change.capturedUrl,
          capturedStorageState: change.capturedStorageState,
          siblingTabs: change.siblingTabs.map((sibling) => ({
            tabId: sibling.tabId,
            registrationId: sibling.registrationId,
            url: sibling.url,
            capturedStorageState: sibling.capturedStorageState,
          })),
          reason: change.reason,
        });
      } catch (cause: unknown) {
        settleElectronTabHandoffAck(
          requestId,
          owner,
          cause instanceof Error ? cause : new Error(String(cause)),
        );
        throw cause;
      }
    });
    disposeNativeSubscriptions = () => {
      statusSubscription.dispose();
      handoffSubscription.dispose();
    };
  };

  const activateAcceptedBirth = (birth: ElectronTabBirth): void => {
    const provisioned = acceptedProvisioning(birth);
    if (birth.activated || provisioned === null) return;
    birth.activated = true;
    void birth.native
      .acceptTab({
        hostId: options.hostId,
        sessionId: birth.create.sessionId,
        tabId: birth.create.tabId,
        registrationId: provisioned.registrationId,
      })
      .catch((cause: unknown) => {
        appLogger.warn("[browser] electron tab activation failed", {
          cause: cause instanceof Error ? cause.message : String(cause),
          sessionId: birth.create.sessionId,
          tabId: birth.create.tabId,
        });
      });
  };

  const publishAcceptedBirth = (birth: ElectronTabBirth): void => {
    const provisioned = acceptedProvisioning(birth);
    if (birth.published || provisioned === null) return;
    birth.published = true;
    const create = birth.create;
    publishElectronTabBinding(owner, {
      hostId: options.hostId,
      sessionId: create.sessionId,
      tabId: create.tabId,
      registrationId: provisioned.registrationId,
      control: (action) =>
        birth.native.controlElectronTab({
          hostId: options.hostId,
          sessionId: create.sessionId,
          tabId: create.tabId,
          registrationId: provisioned.registrationId,
          action,
        }),
      bindSurface: (input) =>
        bindSurface({
          ...input,
          hostId: options.hostId,
          sessionId: create.sessionId,
          tabId: create.tabId,
          registrationId: provisioned.registrationId,
        }),
    });
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

    const tabKey = nativeTabKey(options.hostId, frame.sessionId, frame.tabId);
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
      if (previous !== undefined) retireBirth(previous);
    }

    const native = options.native;
    if (native === null) {
      sendCreateFailure(
        options,
        frame,
        "native_unavailable",
        "Electron browser bridge is unavailable.",
      );
      return Promise.resolve();
    }
    ensureNativeSubscriptions(native);

    const birth: ElectronTabBirth = {
      create: frame,
      native,
      settled: native
        .ensureTab({
          hostId: options.hostId,
          sessionId: frame.sessionId,
          tabId: frame.tabId,
          requestedUrl: frame.requestedUrl,
          seedStorageState: frame.seedStorageState,
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
            void birth.native.releaseTab(provisioned).catch(ignoreError);
            retireBirth(birth);
            return;
          }
          birth.provisioned = provisioned;
          if (birth.cancelled || !isCurrentConnection(generation)) {
            rollbackUnacceptedBirth(birth);
            return;
          }
          const settlement = {
            kind: "electronTabProvisioned",
            hasBinaryPayload: false,
            requestId: frame.requestId,
            sessionId: frame.sessionId,
            tabId: frame.tabId,
            registrationId: provisioned.registrationId,
          } as const;
          options.sendFrame(settlement);
          activateAcceptedBirth(birth);
          publishAcceptedBirth(birth);
        })
        .catch((cause: unknown) => {
          if (birth.cancelled || !isCurrentConnection(generation)) return;
          const failure = createFailureFrame(
            frame,
            "native_create_failed",
            cause instanceof Error ? cause.message : String(cause),
          );
          options.sendFrame(failure);
          retireBirth(birth);
        }),
      provisioned: null,
      accepted: null,
      cancelled: false,
      activated: false,
      published: false,
      activeSurface: null,
      surfaceMutation: Promise.resolve(),
      lastStatus: null,
    };
    birthByRequestId.set(frame.requestId, birth);
    requestIdByTabKey.set(tabKey, frame.requestId);
    return birth.settled;
  };

  const release = async (frame: ReleaseElectronTabFrame): Promise<void> => {
    const tabKey = nativeTabKey(options.hostId, frame.sessionId, frame.tabId);
    const createRequestId = requestIdByTabKey.get(tabKey);
    if (createRequestId === undefined) return;
    const birth = birthByRequestId.get(createRequestId);
    if (birth === undefined) return;
    await birth.settled;
    if (birth.provisioned?.registrationId !== frame.registrationId) return;

    return releaseBirth(birth);
  };

  const bindSurface = async (
    input: BrowserViewAttachSurface,
  ): Promise<ElectronTabSurfaceLease> => {
    if (input.hostId !== options.hostId) {
      throw new Error("Electron tab belongs to a different host.");
    }
    const tabKey = nativeTabKey(input.hostId, input.sessionId, input.tabId);
    const requestId = requestIdByTabKey.get(tabKey);
    const birth =
      requestId === undefined ? undefined : birthByRequestId.get(requestId);
    if (
      !connected ||
      birth === undefined ||
      birth.cancelled ||
      acceptedProvisioning(birth) === null
    ) {
      throw new Error("Electron tab is not accepted.");
    }
    const token = Symbol(input.bindingId);
    const attach = birth.surfaceMutation.then(async () => {
      if (!connected || birth.cancelled) {
        throw new Error("Electron tab is not accepted.");
      }
      const previous = birth.activeSurface;
      if (previous !== null) {
        // Keep the old binding recorded until the native detach actually
        // resolves: a rejected detach leaves the surface attached, so the
        // failed bind must leave a retry able to detach it again.
        await birth.native.detachSurface({
          hostId: previous.input.hostId,
          sessionId: previous.input.sessionId,
          tabId: previous.input.tabId,
          registrationId: previous.input.registrationId,
          bindingId: previous.input.bindingId,
        });
        birth.activeSurface = null;
      }
      await birth.native.attachSurface(input);
      birth.activeSurface = { token, input };
      if (birth.lastStatus !== null) {
        sendCurrentTabState(birth, birth.lastStatus);
      }
    });
    birth.surfaceMutation = attach.catch(ignoreError);
    await attach;
    let detached = false;
    return {
      detach: async () => {
        if (detached) return;
        detached = true;
        const detach = birth.surfaceMutation.then(async () => {
          if (birth.activeSurface?.token !== token) return;
          await birth.native.detachSurface({
            hostId: input.hostId,
            sessionId: input.sessionId,
            tabId: input.tabId,
            registrationId: input.registrationId,
            bindingId: input.bindingId,
          });
          birth.activeSurface = null;
          if (birth.lastStatus !== null) {
            sendCurrentTabState(birth, birth.lastStatus);
          }
        });
        birth.surfaceMutation = detach.catch(ignoreError);
        await detach;
      },
    };
  };

  const handleCdpFrame = (frame: BrowserSessionsServerFrame): boolean => {
    if (frame.kind !== "cdpRequest") return false;
    if (!connected || disposed) return true;
    const request = frame;
    const generation = connectionGeneration;
    const birth = findProvisionedBirthByTabId(
      birthByRequestId.values(),
      request.tabId,
    );
    if (
      birth === null ||
      birth.provisioned?.registrationId !== request.registrationId
    ) {
      sendCdpResult(options, request.requestId, {
        kind: request.command.kind,
        ok: false,
        error: {
          kind: "tab_not_found",
          message: "Electron tab incarnation is not active in this renderer.",
          code: null,
        },
      });
      return true;
    }
    void dispatchCdp(request, birth).then((result) => {
      if (!isCurrentConnection(generation)) return;
      sendCdpResult(options, request.requestId, result);
    });
    return true;
  };

  async function dispatchCdp(
    request: CdpRequestFrame,
    birth: ElectronTabBirth,
  ): Promise<BrowserCdpResult> {
    try {
      return await birth.native.dispatchElectronTabCdp({
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

  const handleActionAck = (frame: ActionAckFrame): boolean =>
    settleElectronTabHandoffAck(
      frame.requestId,
      owner,
      frame.ok
        ? null
        : new Error(frame.reason ?? "Electron tab handoff was rejected."),
    );

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

  return {
    handleFrame: (frame) => {
      switch (frame.kind) {
        case "actionAck":
          return handleActionAck(frame);
        case "createElectronTab":
          if (connected && !disposed) void acceptCreate(frame);
          return true;
        case "releaseElectronTab":
          if (connected && !disposed) void release(frame);
          return true;
        case "electronTabAccepted":
          if (connected && !disposed) handleAccepted(frame);
          return true;
        case "cdpRequest":
          return handleCdpFrame(frame);
        default:
          return false;
      }
    },
    connect: () => {
      if (!disposed) connected = true;
    },
    disconnect: () => {
      connected = false;
      connectionGeneration += 1;
      rejectPendingHandoffs(
        "Electron tab handoff stream disconnected before acknowledgement.",
      );
      for (const birth of birthByRequestId.values()) {
        rollbackUnacceptedBirth(birth);
      }
      removeOwnedElectronTabBindings(owner);
    },
    dispose: () => {
      disposed = true;
      connected = false;
      connectionGeneration += 1;
      for (const birth of birthByRequestId.values()) {
        rollbackUnacceptedBirth(birth);
      }
      disposeNativeSubscriptions?.();
      disposeNativeSubscriptions = null;
      removeOwnedElectronTabBindings(owner);
      rejectPendingHandoffs(
        "Electron tab handoff transport closed before acknowledgement.",
      );
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
    viewed: birth.activeSurface !== null,
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
    )
      return birth;
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

function canReplaceElectronTabBirth(
  frame: CreateElectronTabFrame,
  previous: ElectronTabBirth | undefined,
): boolean {
  if (frame.reason !== "restore") return false;
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
