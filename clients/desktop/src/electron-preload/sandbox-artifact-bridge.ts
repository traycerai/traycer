import { ipcRenderer } from "electron";
import {
  RunnerHostEvent,
  RunnerHostInvoke,
} from "../ipc-contracts/ipc-channels";
import type {
  SandboxArtifactBridge,
  SandboxArtifactCancel,
  SandboxArtifactRequest,
} from "../ipc-contracts/sandbox-artifact-types";
import { subscribe } from "./subscribe";

export function buildSandboxArtifactBridge(): SandboxArtifactBridge {
  return {
    policySource: "traycer-sandbox:",
    artifactOrigin: ({ artifactId, mountId }) =>
      `traycer-sandbox://artifact-${artifactId}--${mountId}`,
    register: (mountId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sandboxArtifactRegister,
        mountId,
      ) as Promise<void>,
    unregister: (mountId) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sandboxArtifactUnregister,
        mountId,
      ) as Promise<void>,
    onRequest: (handler) =>
      subscribe<SandboxArtifactRequest>(
        RunnerHostEvent.sandboxArtifactRequest,
        handler,
      ),
    onCancel: (handler) =>
      subscribe<SandboxArtifactCancel>(
        RunnerHostEvent.sandboxArtifactCancel,
        handler,
      ),
    respond: (reply) =>
      ipcRenderer.invoke(
        RunnerHostInvoke.sandboxArtifactRespond,
        reply,
      ) as Promise<void>,
  };
}
