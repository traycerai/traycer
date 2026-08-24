import { useSyncExternalStore } from "react";
import { z } from "zod";
import type {
  BrowserSessionsClientFrame,
  BrowserSessionsServerFrame,
} from "@traycer/protocol/host/browser/contracts";
import type {
  BrowserViewAttachSurface,
  BrowserViewElectronTabControlAction,
  BrowserViewNativeTabCapability,
  BrowserViewNativeTabKey,
  BrowserViewNativeTabStatusChange,
  BrowserViewProvisionedTab,
  DesktopElectronTabLifecycleBridge,
} from "./desktop-browser-view";
import { appLogger } from "@/lib/logger";
import {
  browserCdpRequestFromFrame,
  buildCdpResultFrame,
} from "./browser-cdp-frames";

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

type ElectronTabSurfaceBinding = Omit<
  BrowserViewAttachSurface,
  keyof BrowserViewNativeTabCapability
>;
type ElectronTabSurfaceUpdate = Omit<ElectronTabSurfaceBinding, "bindingId">;

interface ElectronTabNativeSubscription {
  dispose(): void;
}

export interface ElectronTabPresentation {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly url: string;
  readonly reason: CreateElectronTabFrame["reason"];
}

export interface ElectronTabsOptions {
  readonly epicId: string;
  readonly hostId: string;
  readonly native: DesktopElectronTabLifecycleBridge | null;
  readonly sendFrame: (frame: BrowserSessionsClientFrame) => void;
  readonly present: (presentation: ElectronTabPresentation) => void;
}

export interface ElectronTabBinding extends BrowserViewNativeTabCapability {
  readonly url: string;
  readonly title: string | null;
  readonly control: (
    action: BrowserViewElectronTabControlAction,
  ) => Promise<void>;
  readonly bindSurface: (
    input: ElectronTabSurfaceBinding,
  ) => Promise<ElectronTabSurfaceLease>;
}

interface ElectronTabDirectoryEntry {
  readonly owner: object;
  readonly binding: ElectronTabBinding;
}

const directory = new Map<string, ElectronTabDirectoryEntry>();
const directoryListeners = new Set<() => void>();
const pendingHandoffAcks = new Map<
  string,
  {
    readonly owner: object;
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
  readonly native: DesktopElectronTabLifecycleBridge;
  readonly settled: Promise<void>;
  provisioned: BrowserViewProvisionedTab | null;
  accepted: ElectronTabAcceptedFrame | null;
  activated: boolean;
  presented: boolean;
  readonly surfaceVisibilityByBindingId: Map<string, boolean>;
  lastStatus: BrowserViewNativeTabStatusChange | null;
}

const electronTabHandoffStorageStateSchema = z.json().nullable();

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
  const owner = {};
  let disposed = false;
  let connected = true;
  const birthByRequestId = new Map<string, ElectronTabBirth>();
  const requestIdByTabKey = new Map<string, string>();
  const settlementByRequestId = new Map<
    string,
    Extract<
      BrowserSessionsClientFrame,
      {
        readonly kind: "electronTabProvisioned" | "electronTabCreateFailed";
      }
    >
  >();
  const releaseByIncarnation = new Map<string, Promise<void>>();
  let nativeSubscriptions: readonly ElectronTabNativeSubscription[] | null =
    null;

  async function releaseBirth(birth: ElectronTabBirth): Promise<void> {
    if (birth.provisioned === null) return;
    const tabKey = nativeTabKey(
      options.hostId,
      birth.create.sessionId,
      birth.create.tabId,
    );
    const incarnationKey = [tabKey, birth.provisioned.registrationId].join("\u001f");
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

  const ensureNativeSubscriptions = (
    native: DesktopElectronTabLifecycleBridge,
  ): void => {
    if (nativeSubscriptions !== null) return;
    nativeSubscriptions = [
      native.onNativeTabStatusChange((change) => {
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
        updateOwnedDirectoryBinding(birth, options, owner);
        sendTabState(options, birth, change);
      }),
      native.onNativeTabCdpSessionEnded((change) => {
        const birth = findProvisionedBirth(
          birthByRequestId.values(),
          change.hostId,
          change.sessionId,
          change.tabId,
        );
        if (birth?.provisioned?.registrationId !== change.registrationId) {
          return;
        }
        options.sendFrame({
          kind: "cdpSessionEnded",
          hasBinaryPayload: false,
          requestId: crypto.randomUUID(),
          target: { kind: "electron-tab", tabId: change.tabId },
          registrationId: change.registrationId,
          reason: change.reason,
        });
      }),
      native.onNativeTabCdpTargetAttached((change) => {
        const birth = findProvisionedBirth(
          birthByRequestId.values(),
          change.hostId,
          change.sessionId,
          change.tabId,
        );
        if (birth?.provisioned?.registrationId !== change.registrationId) {
          return;
        }
        options.sendFrame({
          kind: "cdpTargetAttached",
          hasBinaryPayload: false,
          requestId: crypto.randomUUID(),
          target: { kind: "electron-tab", tabId: change.tabId },
          registrationId: change.registrationId,
          cdpSessionId: change.cdpSessionId,
          targetId: change.targetId,
          targetType: change.targetType,
          url: change.url,
          waitingForDebugger: change.waitingForDebugger,
        });
      }),
      native.onElectronTabHandoff((change) => {
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
          options.sendFrame({
            kind: "electronTabHandoff",
            hasBinaryPayload: false,
            requestId,
            sessionId: change.sessionId,
            tabId: change.tabId,
            registrationId: change.registrationId,
            capturedUrl: change.capturedUrl,
            capturedStorageState: jsonPayload(change.capturedStorageState),
            siblingTabs: change.siblingTabs.map((sibling) => ({
              tabId: sibling.tabId,
              registrationId: sibling.registrationId,
              url: sibling.url,
              capturedStorageState: jsonPayload(sibling.capturedStorageState),
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
      }),
    ];
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
    const presentation = acceptedPresentation(options, birth);
    if (presentation === null || provisioned === null) return;
    const key = nativeTabKey(
      options.hostId,
      presentation.sessionId,
      presentation.tabId,
    );
    directory.set(key, {
      owner,
      binding: {
        hostId: options.hostId,
        sessionId: presentation.sessionId,
        tabId: presentation.tabId,
        registrationId: provisioned.registrationId,
        url: birth.lastStatus?.url ?? presentation.url,
        title: birth.lastStatus?.title ?? null,
        control: (action) =>
          birth.native.controlElectronTab({
            hostId: options.hostId,
            sessionId: presentation.sessionId,
            tabId: presentation.tabId,
            registrationId: provisioned.registrationId,
            action,
          }),
        bindSurface: (input) =>
          bindSurface({
            ...input,
            hostId: options.hostId,
            sessionId: presentation.sessionId,
            tabId: presentation.tabId,
            registrationId: provisioned.registrationId,
          }),
      },
    });
    notifyDirectoryListeners();
    try {
      options.present(presentation);
    } catch (cause: unknown) {
      appLogger.warn("[browser] electron tab presentation failed", {
        cause: cause instanceof Error ? cause.message : String(cause),
        sessionId: presentation.sessionId,
        tabId: presentation.tabId,
      });
    }
  };

  const acceptCreate = (frame: CreateElectronTabFrame): Promise<void> => {
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
      if (settlement !== undefined) options.sendFrame(settlement);
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
      const retainedIncarnation =
        previous?.provisioned !== null &&
        previous?.provisioned !== undefined &&
        previous.accepted?.registrationId ===
          previous.provisioned.registrationId;
      const failedBirth =
        previousSettlement?.kind === "electronTabCreateFailed";
      if (
        frame.reason !== "restore" ||
        (!retainedIncarnation && !failedBirth)
      ) {
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

    let birth: ElectronTabBirth;
    const settled = native
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
        if (disposed || !connected) {
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
        if (disposed || !connected) return;
        const failure = createFailureFrame(
          frame,
          "native_create_failed",
          cause instanceof Error ? cause.message : String(cause),
        );
        settlementByRequestId.set(frame.requestId, failure);
        options.sendFrame(failure);
      });
    birth = {
      create: frame,
      native,
      settled,
      provisioned: null,
      accepted: null,
      activated: false,
      presented: false,
      surfaceVisibilityByBindingId: new Map(),
      lastStatus: null,
    };
    birthByRequestId.set(frame.requestId, birth);
    requestIdByTabKey.set(tabKey, frame.requestId);
    return settled;
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
      sendTabState(options, birth, birth.lastStatus);
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
          sendTabState(options, birth, birth.lastStatus);
        }
      },
      detach: async () => {
        if (detached) return;
        detached = true;
        birth.surfaceVisibilityByBindingId.delete(input.bindingId);
        if (birth.lastStatus !== null) {
          sendTabState(options, birth, birth.lastStatus);
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
    const request = browserCdpRequestFromFrame(frame);
    if (request === null || request.target.kind !== "electron-tab")
      return false;
    const birth = findProvisionedBirthByTabId(
      birthByRequestId.values(),
      request.target.tabId,
    );
    if (
      birth === null ||
      request.registrationId === null ||
      birth.provisioned?.registrationId !== request.registrationId
    ) {
      options.sendFrame(
        buildCdpResultFrame(
          request.requestId,
          request.target,
          request.registrationId,
          {
            kind: request.command.kind,
            ok: false,
            error: {
              kind: "tab_not_found",
              message:
                "Electron tab incarnation is not active in this renderer.",
              code: null,
            },
          },
        ),
      );
      return true;
    }
    void birth.native
      .dispatchElectronTabCdp({
        hostId: options.hostId,
        sessionId: birth.create.sessionId,
        tabId: birth.create.tabId,
        registrationId: request.registrationId,
        cdpSessionId: request.cdpSessionId,
        command: request.command,
      })
      .then((result) => {
        options.sendFrame(
          buildCdpResultFrame(
            request.requestId,
            request.target,
            request.registrationId,
            result,
          ),
        );
      })
      .catch((cause: unknown) => {
        options.sendFrame(
          buildCdpResultFrame(
            request.requestId,
            request.target,
            request.registrationId,
            {
              kind: request.command.kind,
              ok: false,
              error: {
                kind: "cdp_error",
                message: cause instanceof Error ? cause.message : String(cause),
                code: null,
              },
            },
          ),
        );
      });
    return true;
  };

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
        sendTabState(options, birth, birth.lastStatus);
      }
      presentAcceptedBirth(birth);
      return true;
    },
    disconnect: () => {
      connected = false;
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
      for (const birth of birthByRequestId.values()) {
        rollbackUnacceptedBirth(birth);
      }
      if (nativeSubscriptions !== null) {
        for (const subscription of nativeSubscriptions) subscription.dispose();
        nativeSubscriptions = null;
      }
      for (const [key, entry] of directory) {
        if (entry.owner === owner) directory.delete(key);
      }
      for (const [requestId, pending] of pendingHandoffAcks) {
        if (pending.owner !== owner) continue;
        pendingHandoffAcks.delete(requestId);
        pending.reject(
          new Error(
            "Electron tab handoff transport closed before acknowledgement.",
          ),
        );
      }
      notifyDirectoryListeners();
    },
  };
}

function acceptedPresentation(
  options: ElectronTabsOptions,
  birth: ElectronTabBirth,
): ElectronTabPresentation | null {
  if (
    birth.presented ||
    birth.provisioned === null ||
    birth.accepted === null
  ) {
    return null;
  }
  if (birth.accepted.registrationId !== birth.provisioned.registrationId)
    return null;
  birth.presented = true;
  return {
    epicId: options.epicId,
    hostId: options.hostId,
    sessionId: birth.create.sessionId,
    tabId: birth.create.tabId,
    url: birth.create.requestedUrl,
    reason: birth.create.reason,
  };
}

export function findElectronTabBindingOnHost(
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

export function resetElectronTabsForTests(): void {
  directory.clear();
  directoryListeners.clear();
  for (const pending of pendingHandoffAcks.values()) pending.resolve();
  pendingHandoffAcks.clear();
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

function removeOwnedDirectoryEntry(key: string, owner: object): void {
  if (directory.get(key)?.owner !== owner) return;
  directory.delete(key);
  notifyDirectoryListeners();
}

function updateOwnedDirectoryBinding(
  birth: ElectronTabBirth,
  options: ElectronTabsOptions,
  owner: object,
): void {
  if (birth.provisioned === null || birth.lastStatus === null) return;
  const key = nativeTabKey(
    options.hostId,
    birth.create.sessionId,
    birth.create.tabId,
  );
  const entry = directory.get(key);
  if (entry?.owner !== owner) return;
  directory.set(key, {
    owner,
    binding: {
      ...entry.binding,
      url: birth.lastStatus.url,
      title: birth.lastStatus.title,
    },
  });
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
    requestId: crypto.randomUUID(),
    registrationId: birth.provisioned.registrationId,
    sessionId: birth.create.sessionId,
    tabId: birth.create.tabId,
    url: change.url,
    title: change.title,
    status:
      change.status === "dead"
        ? "crashed"
        : change.status === "loading"
          ? "navigating"
          : "ready",
    viewed: [...birth.surfaceVisibilityByBindingId.values()].some(Boolean),
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
    if (birth.create.tabId === tabId && birth.provisioned !== null) return birth;
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

function identityMessage(frame: CreateElectronTabFrame): string {
  return `Electron tab identity violation for request ${frame.requestId}, session ${frame.sessionId}, tab ${frame.tabId}.`;
}

function jsonPayload(
  value: unknown,
): Extract<
  BrowserSessionsClientFrame,
  { readonly kind: "electronTabHandoff" }
>["capturedStorageState"] {
  const parsed = electronTabHandoffStorageStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
