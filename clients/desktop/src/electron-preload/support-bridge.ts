import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  DesktopRuntimePlatform,
  SupportBuildPublicDraftResult,
  SupportFingerprintOccurrence,
  SupportFreezeEvidenceInput,
  SupportFreezeEvidenceResult,
  SupportLogTarget,
  SupportLogTailResult,
  SupportReadFrozenLogTailInput,
  SupportRevealLogResult,
  SupportSaveDiagnosticBundleResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
} from "../ipc-contracts/window-types";
import type {
  DesktopNotificationFeedSource,
  DesktopNotificationForegroundAppLocal,
  DesktopNotificationForegroundDisplay,
  DesktopNotificationShowOutcome,
} from "../ipc-contracts/notification-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

const MAX_BUFFERED_FOREGROUND_NOTIFICATION_DISPLAYS = 20;

interface ForegroundNotificationDisplayChannel {
  subscribe(
    handler: Listener<DesktopNotificationForegroundDisplay>,
  ): Disposable;
}

/**
 * Installs the main -> preload listener as soon as the bridge is built, before
 * React can mount. Events that arrive during renderer startup/reload are kept
 * until the first GUI subscriber is ready, then delivered exactly once.
 */
function createForegroundNotificationDisplayChannel(): ForegroundNotificationDisplayChannel {
  const handlers = new Set<Listener<DesktopNotificationForegroundDisplay>>();
  const buffered: DesktopNotificationForegroundDisplay[] = [];

  ipcRenderer.on(
    RunnerHostEvent.notificationForegroundDisplay,
    (_event: unknown, payload: unknown): void => {
      const display = payload as DesktopNotificationForegroundDisplay;
      if (handlers.size === 0) {
        if (buffered.length >= MAX_BUFFERED_FOREGROUND_NOTIFICATION_DISPLAYS) {
          const dropped = buffered.shift();
          console.warn(
            "[preload] dropped buffered foreground notification display",
            { deliveryKey: dropped?.deliveryKey ?? null },
          );
        }
        buffered.push(display);
        return;
      }
      for (const handler of handlers) {
        handler(display);
      }
    },
  );

  return {
    subscribe: (handler) => {
      handlers.add(handler);
      const pending = buffered.splice(0);
      for (const display of pending) {
        handler(display);
      }
      return {
        dispose: () => {
          handlers.delete(handler);
        },
      };
    },
  };
}

export interface SupportBridgeSurface {
  openExternalLink(url: string): Promise<void>;
  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]>;
  requestMicrophoneAccess(): Promise<"granted" | "denied">;
  openMicrophoneSettings(): Promise<void>;
  notifications: {
    readonly systemSettings: { open(): Promise<void> } | null;
    show(
      title: string,
      body: string,
      payload: unknown,
      replaceKey: string | null,
      deliveryKey: string | null,
      feedSource: DesktopNotificationFeedSource | null,
      foregroundAppLocal: DesktopNotificationForegroundAppLocal | null,
    ): Promise<DesktopNotificationShowOutcome>;
    onClick(handler: Listener<unknown>): Disposable;
    onForegroundDisplay(
      handler: Listener<DesktopNotificationForegroundDisplay>,
    ): Disposable;
  };
  workspaceFolders: {
    pickFolders(): Promise<readonly string[]>;
  };
  support: {
    getSnapshot(): Promise<SupportSnapshot>;
    revealLog(target: SupportLogTarget): Promise<SupportRevealLogResult>;
    submitReport(
      form: SupportSubmitReportRequest,
    ): Promise<SupportSubmitReportResult>;
    tailLog(input: {
      readonly target: SupportLogTarget;
      readonly tailLines: number;
    }): Promise<SupportLogTailResult>;
    freezeEvidence(
      input: SupportFreezeEvidenceInput,
    ): Promise<SupportFreezeEvidenceResult>;
    discardFrozenEvidence(draftId: number): Promise<void>;
    readFrozenLogTail(
      input: SupportReadFrozenLogTailInput,
    ): Promise<SupportLogTailResult>;
    saveDiagnosticBundle(
      form: SupportSubmitReportRequest,
    ): Promise<SupportSaveDiagnosticBundleResult>;
    getFingerprintOccurrence(
      fingerprint: string,
    ): Promise<SupportFingerprintOccurrence | null>;
    buildPublicDraft(
      form: SupportSubmitReportRequest,
    ): Promise<SupportBuildPublicDraftResult>;
  };
}

export function buildSupportBridge(
  platform: DesktopRuntimePlatform,
): SupportBridgeSurface {
  const foregroundNotificationDisplays =
    createForegroundNotificationDisplayChannel();
  return {
    openExternalLink: (url) =>
      ipcRenderer.invoke(RunnerHostInvoke.openExternalLink, url),

    getRegisteredUrlSchemes: (schemes) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.getRegisteredUrlSchemes,
        schemes,
      ) as Promise<readonly string[]>,

    requestMicrophoneAccess: () =>
      ipcRenderer.invoke(RunnerHostInvoke.requestMicrophoneAccess) as Promise<
        "granted" | "denied"
      >,

    openMicrophoneSettings: () =>
      ipcRenderer.invoke(RunnerHostInvoke.openMicrophoneSettings),

    notifications: {
      systemSettings:
        platform === "darwin" || platform === "win32"
          ? {
              open: () =>
                ipcRenderer.invoke(
                  RunnerHostInvoke.notificationOpenSystemSettings,
                ),
            }
          : null,
      show: (
        title,
        body,
        payload,
        replaceKey,
        deliveryKey,
        feedSource,
        foregroundAppLocal,
      ) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.notificationShow,
          title,
          body,
          payload,
          replaceKey,
          deliveryKey,
          feedSource,
          foregroundAppLocal,
        ) as Promise<DesktopNotificationShowOutcome>,
      onClick: (handler) =>
        subscribe<unknown>(RunnerHostEvent.notificationClick, handler),
      onForegroundDisplay: (handler) =>
        foregroundNotificationDisplays.subscribe(handler),
    },

    workspaceFolders: {
      pickFolders: () =>
        ipcRenderer.invoke(RunnerHostInvoke.workspaceFoldersPick) as Promise<
          readonly string[]
        >,
    },

    support: {
      getSnapshot: () =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportSnapshotGet,
        ) as Promise<SupportSnapshot>,
      revealLog: (target) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportRevealLog,
          target,
        ) as Promise<SupportRevealLogResult>,
      submitReport: (form) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportSubmitReport,
          form,
        ) as Promise<SupportSubmitReportResult>,
      tailLog: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportTailLog,
          input,
        ) as Promise<SupportLogTailResult>,
      freezeEvidence: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportFreezeEvidence,
          input,
        ) as Promise<SupportFreezeEvidenceResult>,
      discardFrozenEvidence: (draftId) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportDiscardFrozenEvidence,
          draftId,
        ),
      readFrozenLogTail: (input) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportReadFrozenLogTail,
          input,
        ) as Promise<SupportLogTailResult>,
      saveDiagnosticBundle: (form) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportSaveDiagnosticBundle,
          form,
        ) as Promise<SupportSaveDiagnosticBundleResult>,
      getFingerprintOccurrence: (fingerprint) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportGetFingerprintOccurrence,
          fingerprint,
        ) as Promise<SupportFingerprintOccurrence | null>,
      buildPublicDraft: (form) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.supportBuildPublicDraft,
          form,
        ) as Promise<SupportBuildPublicDraftResult>,
    },
  };
}
