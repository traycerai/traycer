import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  SupportLogTarget,
  SupportLogTailResult,
  SupportRevealLogResult,
  SupportSnapshot,
  SupportSubmitReportRequest,
  SupportSubmitReportResult,
} from "../ipc-contracts/window-types";
import { subscribe, type Disposable, type Listener } from "./subscribe";

export interface SupportBridgeSurface {
  openExternalLink(url: string): Promise<void>;
  getRegisteredUrlSchemes(
    schemes: readonly string[],
  ): Promise<readonly string[]>;
  requestMicrophoneAccess(): Promise<"granted" | "denied">;
  openMicrophoneSettings(): Promise<void>;
  notifications: {
    show(
      title: string,
      body: string,
      payload: unknown,
      replaceKey: string | null,
      deliveryKey: string | null,
    ): Promise<void>;
    onClick(handler: Listener<unknown>): Disposable;
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
  };
}

export function buildSupportBridge(): SupportBridgeSurface {
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
      show: (title, body, payload, replaceKey, deliveryKey) =>
        ipcRenderer.invoke(
          RunnerHostInvoke.notificationShow,
          title,
          body,
          payload,
          replaceKey,
          deliveryKey,
        ),
      onClick: (handler) =>
        subscribe<unknown>(RunnerHostEvent.notificationClick, handler),
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
    },
  };
}
