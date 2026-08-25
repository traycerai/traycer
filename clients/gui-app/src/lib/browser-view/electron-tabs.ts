import { useSyncExternalStore } from "react";
import {
  type BrowserCdpResult,
  type BrowserSessionsClientFrame,
  type BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewAttachSurface,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
  BrowserViewNativeTabStatusChange,
  BrowserViewBridge,
} from "@traycer-clients/shared/platform/browser-view";
import { appLogger } from "@/lib/logger";

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
type ElectronTabCreateSettlement = Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "electronTabProvisioned" | "electronTabCreateFailed" }
>;

type ElectronTabSurfaceBinding = Omit<
  BrowserViewAttachSurface,
  keyof BrowserViewNativeTabCapability
>;
type ElectronTabSurfaceUpdate = Omit<ElectronTabSurfaceBinding, "bindingId">;

interface ElectronTabsOptions {
  readonly hostId: string;
  readonly native: BrowserViewBridge | null;
  readonly sendFrame: (frame: BrowserSessionsClientFrame) => void;
  readonly present: (frame: CreateElectronTabFrame) => void;
}

export interface ElectronTabBinding extends BrowserViewNativeTabCapability {
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly bindSurface: (
    input: ElectronTabSurfaceBinding,
  ) => Promise<ElectronTabSurfaceLease>;
}

interface ElectronTabDirectoryEntry {
  readonly owner: symbol;
  readonly binding: ElectronTabBinding;
}

const directory = new Map<string, ElectronTabDirectoryEntry>();
const directoryListeners = new Set<() => void>();
const pendingHandoffAcks = new Map<
  string,
  {
    readonly owner: symbol;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (cause: Error) => void;
  }
>();

export async function drainElectronTabHandoffs(): Promise<void> {
  await Promise.all(
    Array.from(pendingHandoffAcks.values(), (pending) => pending.promise),
  );
}

interface ElectronTabBirth {
  readonly create: CreateElectronTabFrame;
  readonly native: BrowserViewBridge;
  readonly settled: Promise<void>;
  provisioned: BrowserViewNativeTabCapability | null;
  accepted: ElectronTabAcceptedFrame | null;
  activated: boolean;
  presented: boolean;
  readonly surfaceVisibilityByBindingId: Map<string, boolean>;
  lastStatus: BrowserViewNativeTabStatusChange | null;
}

export interface ElectronTabs {
  handleFrame(frame: BrowserSessionsServerFrame): boolean;
  disconnect(): void;
  replaySettlements(): void;
  dispose(): void;
}

export interface ElectronTabSurfaceLease {
  update(input: ElectronTabSurfaceUpdate): Promise<void>;
  detach(): Promise<void>;
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
  const settlementByRequestId = new Map<string, ElectronTabCreateSettlement>();
  const releaseByIncarnation = new Map<string, Promise<void>>();
  let disposeNativeSubscriptions: (() => void) | null = null;

  const isCurrentConnection = (generation: number): boolean =>
    !disposed && connected && generation === connectionGeneration;

  const sendOnCurrentConnection = (frame: BrowserSessionsClientFrame): void => {
    if (!disposed && connected) options.sendFrame(frame);
  };

  const rejectPendingHandoffs = (message: string): void => {
    for (const [requestId, pending] of pendingHandoffAcks) {
      if (pending.owner !== owner) continue;
      pendingHandoffAcks.delete(requestId);
      pending.reject(new Error(message));
    }
  };

  const sendCurrentTabState = (
    birth: ElectronTabBirth,
    change: BrowserViewNativeTabStatusChange,
  ): void => {
    if (!disposed && connected) sendTabState(options, birth, change);
  };

  async function releaseBirth(birth: ElectronTabBirth): Promise<void> {
    if (birth.provisioned === null) return;
    const tabKey = nativeTabKey(
      options.hostId,
      birth.create.sessionId,
      birth.create.tabId,
    );
    const incarnationKey = [tabKey, birth.provisioned.registrationId].join(
      "\u001f",
    );
    const existing = releaseByIncarnation.get(incarnationKey);
    if (existing !== undefined) return existing;
    const pending = birth.native
      .releaseTab({
        hostId: options.hostId,
        sessionId: birth.create.sessionId,
        tabId: birth.create.tabId,
        registrationId: birth.provisioned.registrationId,
      })
      .then(() => {
        removeOwnedDirectoryEntry(tabKey, owner);
        birthByRequestId.delete(birth.create.requestId);
        requestIdByTabKey.delete(tabKey);
        settlementByRequestId.delete(birth.create.requestId);
      })
      .catch((cause: unknown) => {
        releaseByIncarnation.delete(incarnationKey);
        throw cause;
      });
    releaseByIncarnation.set(incarnationKey, pending);
    return pending;
  }

  function rollbackUnacceptedBirth(birth: ElectronTabBirth): void {
    if (
      birth.provisioned === null ||
      birth.accepted?.registrationId === birth.provisioned.registrationId
    ) {
      return;
    }
    const tabKey = nativeTabKey(
      options.hostId,
      birth.create.sessionId,
      birth.create.tabId,
    );
    birthByRequestId.delete(birth.create.requestId);
    if (requestIdByTabKey.get(tabKey) === birth.create.requestId) {
      requestIdByTabKey.delete(tabKey);
    }
    settlementByRequestId.delete(birth.create.requestId);
    void releaseBirth(birth).catch(() => undefined);
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
      let settle: (() => void) | null = null;
      let fail: ((cause: Error) => void) | null = null;
      const promise = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      // ACKs can arrive when no quit drain is observing. Keep the original
      // promise rejectable for active drains without leaking globally.
      void promise.catch(() => undefined);
      const pending = {
        owner,
        promise,
        resolve: () => settle?.(),
        reject: (cause: Error) => fail?.(cause),
      };
      pendingHandoffAcks.set(requestId, pending);
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
        pendingHandoffAcks.delete(requestId);
        pending.reject(
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
    const provisioned = birth.provisioned;
    if (
      birth.activated ||
      provisioned === null ||
      birth.accepted?.registrationId !== provisioned.registrationId
    ) {
      return;
    }
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

  const presentAcceptedBirth = (birth: ElectronTabBirth): void => {
    const provisioned = birth.provisioned;
    if (
      birth.presented ||
      provisioned === null ||
      birth.accepted?.registrationId !== provisioned.registrationId
    ) {
      return;
    }
    birth.presented = true;
    const create = birth.create;
    const key = nativeTabKey(options.hostId, create.sessionId, create.tabId);
    directory.set(key, {
      owner,
      binding: {
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
      },
    });
    notifyDirectoryListeners();
    try {
      options.present(create);
    } catch (cause: unknown) {
      appLogger.warn("[browser] electron tab presentation failed", {
        cause: cause instanceof Error ? cause.message : String(cause),
        sessionId: create.sessionId,
        tabId: create.tabId,
      });
    }
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
      const settlement = settlementByRequestId.get(frame.requestId);
      if (settlement !== undefined && isCurrentConnection(generation)) {
        options.sendFrame(settlement);
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
      const previousSettlement = settlementByRequestId.get(existingRequestId);
      if (!canReplaceElectronTabBirth(frame, previous, previousSettlement)) {
        sendCreateFailure(
          options,
          frame,
          "identity_violation",
          identityMessage(frame),
        );
        return Promise.resolve();
      }
      birthByRequestId.delete(existingRequestId);
      settlementByRequestId.delete(existingRequestId);
      requestIdByTabKey.delete(tabKey);
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
            return;
          }
          birth.provisioned = provisioned;
          if (!isCurrentConnection(generation)) {
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
          settlementByRequestId.set(frame.requestId, settlement);
          options.sendFrame(settlement);
          activateAcceptedBirth(birth);
          presentAcceptedBirth(birth);
        })
        .catch((cause: unknown) => {
          if (!isCurrentConnection(generation)) return;
          const failure = createFailureFrame(
            frame,
            "native_create_failed",
            cause instanceof Error ? cause.message : String(cause),
          );
          settlementByRequestId.set(frame.requestId, failure);
          options.sendFrame(failure);
        }),
      provisioned: null,
      accepted: null,
      activated: false,
      presented: false,
      surfaceVisibilityByBindingId: new Map(),
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
      birth?.provisioned === null ||
      birth?.provisioned === undefined ||
      birth.accepted?.registrationId !== birth.provisioned.registrationId
    ) {
      throw new Error("Electron tab is not accepted.");
    }
    await birth.native.attachSurface(input);
    birth.surfaceVisibilityByBindingId.set(input.bindingId, input.visible);
    if (birth.lastStatus !== null) {
      sendCurrentTabState(birth, birth.lastStatus);
    }
    let detached = false;
    return {
      update: async (update) => {
        if (detached) throw new Error("Electron tab surface is detached.");
        await birth.native.attachSurface({
          ...update,
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
          registrationId: input.registrationId,
          bindingId: input.bindingId,
        });
        birth.surfaceVisibilityByBindingId.set(input.bindingId, update.visible);
        if (birth.lastStatus !== null) {
          sendCurrentTabState(birth, birth.lastStatus);
        }
      },
      detach: async () => {
        if (detached) return;
        detached = true;
        birth.surfaceVisibilityByBindingId.delete(input.bindingId);
        if (birth.lastStatus !== null) {
          sendCurrentTabState(birth, birth.lastStatus);
        }
        await birth.native.detachSurface({
          hostId: input.hostId,
          sessionId: input.sessionId,
          tabId: input.tabId,
          registrationId: input.registrationId,
          bindingId: input.bindingId,
        });
      },
    };
  };

  const handleCdpFrame = (frame: BrowserSessionsServerFrame): boolean => {
    if (frame.kind !== "cdpRequest") return false;
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

  return {
    handleFrame: (frame) => {
      if (frame.kind === "actionAck") {
        const pending = pendingHandoffAcks.get(frame.requestId);
        if (pending?.owner !== owner) return false;
        pendingHandoffAcks.delete(frame.requestId);
        if (frame.ok) pending.resolve();
        else {
          pending.reject(
            new Error(frame.reason ?? "Electron tab handoff was rejected."),
          );
        }
        return true;
      }
      if (frame.kind === "createElectronTab") {
        void acceptCreate(frame);
        return true;
      }
      if (frame.kind === "releaseElectronTab") {
        void release(frame);
        return true;
      }
      if (frame.kind !== "electronTabAccepted") return handleCdpFrame(frame);
      const birth = birthByRequestId.get(frame.requestId);
      if (
        birth === undefined ||
        birth.create.sessionId !== frame.sessionId ||
        birth.create.tabId !== frame.tabId
      ) {
        return true;
      }
      birth.accepted = frame;
      activateAcceptedBirth(birth);
      if (birth.lastStatus !== null) {
        sendCurrentTabState(birth, birth.lastStatus);
      }
      presentAcceptedBirth(birth);
      return true;
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
    },
    replaySettlements: () => {
      connected = true;
      for (const settlement of settlementByRequestId.values()) {
        options.sendFrame(settlement);
      }
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
      for (const [key, entry] of directory) {
        if (entry.owner === owner) directory.delete(key);
      }
      rejectPendingHandoffs(
        "Electron tab handoff transport closed before acknowledgement.",
      );
      notifyDirectoryListeners();
    },
  };
}

function findElectronTabBindingOnHost(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronTabBinding | null {
  return directory.get(nativeTabKey(hostId, sessionId, tabId))?.binding ?? null;
}

export function useElectronTabBindingOnHost(
  sessionId: string,
  tabId: string,
  hostId: string,
): ElectronTabBinding | null {
  return useSyncExternalStore(
    subscribeDirectory,
    () => findElectronTabBindingOnHost(sessionId, tabId, hostId),
    () => null,
  );
}

function subscribeDirectory(listener: () => void): () => void {
  directoryListeners.add(listener);
  return () => {
    directoryListeners.delete(listener);
  };
}

function notifyDirectoryListeners(): void {
  for (const listener of directoryListeners) listener();
}

function removeOwnedDirectoryEntry(key: string, owner: symbol): void {
  if (directory.get(key)?.owner !== owner) return;
  directory.delete(key);
  notifyDirectoryListeners();
}

function sendTabState(
  options: ElectronTabsOptions,
  birth: ElectronTabBirth,
  change: BrowserViewNativeTabStatusChange,
): void {
  if (
    birth.provisioned === null ||
    birth.accepted?.registrationId !== birth.provisioned.registrationId
  ) {
    return;
  }
  options.sendFrame({
    kind: "electronTabState",
    hasBinaryPayload: false,
    registrationId: birth.provisioned.registrationId,
    sessionId: birth.create.sessionId,
    tabId: birth.create.tabId,
    url: change.url,
    title: change.title,
    status: electronTabStateStatus(change.status),
    viewed: [...birth.surfaceVisibilityByBindingId.values()].some(Boolean),
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

function nativeTabKey(
  hostId: string,
  sessionId: string,
  tabId: string,
): string {
  return [hostId, sessionId, tabId].join("\u001f");
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
    if (birth.create.tabId === tabId && birth.provisioned !== null)
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
  previousSettlement: ElectronTabCreateSettlement | undefined,
): boolean {
  if (frame.reason !== "restore") return false;
  const retainedIncarnation =
    previous?.provisioned !== null &&
    previous?.provisioned !== undefined &&
    previous.accepted?.registrationId === previous.provisioned.registrationId;
  return (
    retainedIncarnation ||
    previousSettlement?.kind === "electronTabCreateFailed"
  );
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
