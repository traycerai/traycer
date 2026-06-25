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
  saveFile(input: FileSaveInput): Promise<string | null>;
}

export function buildFileDropsBridge(): FileDropsBridgeSurface {
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
    saveFile: (input) =>
      ipcRenderer.invoke(RunnerHostInvoke.fileSave, input) as Promise<
        string | null
      >,
  };
}
