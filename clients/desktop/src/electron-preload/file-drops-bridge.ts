import { ipcRenderer, webUtils } from "electron";
import { RunnerHostInvoke } from "../ipc-contracts/ipc-channels";
import type { FileSaveInput } from "../ipc-contracts/platform-types";

export interface FileDropWriteTemporaryInput {
  readonly name: string;
  readonly type: string;
  readonly bytes: ArrayBuffer;
}

export interface FileDropsBridgeSurface {
  getPathForFile(file: File): string;
  writeTemporaryFile(input: FileDropWriteTemporaryInput): Promise<string>;
  copyTemporaryFiles(paths: readonly string[]): Promise<readonly string[]>;
  readNativeClipboardFilePaths(): Promise<readonly string[]>;
  saveFile(input: FileSaveInput): Promise<string | null>;
}

export const NATIVE_CLIPBOARD_PASTE_WINDOW_MS = 2_000;

export interface TrustedPasteEvent {
  readonly isTrusted: boolean;
}

export interface NativeClipboardReadGate {
  readonly observePaste: (event: TrustedPasteEvent) => void;
  readonly allowsRead: () => boolean;
}

export function createNativeClipboardReadGate(
  now: () => number,
): NativeClipboardReadGate {
  let lastTrustedPasteAt: number | null = null;
  return {
    observePaste: (event) => {
      if (!event.isTrusted) return;
      lastTrustedPasteAt = now();
    },
    allowsRead: () => {
      if (lastTrustedPasteAt === null) return false;
      const elapsed = now() - lastTrustedPasteAt;
      return elapsed >= 0 && elapsed <= NATIVE_CLIPBOARD_PASTE_WINDOW_MS;
    },
  };
}

export function buildFileDropsBridge(
  nativeClipboardReadGate: NativeClipboardReadGate,
): FileDropsBridgeSurface {
  return {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    writeTemporaryFile: (input) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.fileDropWriteTemporary,
        input,
      ) as Promise<string>,
    copyTemporaryFiles: (paths) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.fileDropCopyTemporary,
        paths,
      ) as Promise<readonly string[]>,
    readNativeClipboardFilePaths: () =>
      nativeClipboardReadGate.allowsRead()
        ? (ipcRenderer.invoke(
            RunnerHostInvoke.fileDropReadNativeClipboardPaths,
          ) as Promise<readonly string[]>)
        : Promise.resolve([]),
    saveFile: (input) =>
      ipcRenderer.invoke(RunnerHostInvoke.fileSave, input) as Promise<
        string | null
      >,
  };
}
