import type { IpcMainInvokeEvent, WebContents, Event } from "electron";
import { RunnerHostInvoke } from "../../ipc-contracts/ipc-channels";
import type { RunnerIpcBridge } from "./runner-ipc-bridge";
import {
  parseSandboxArtifactMountId,
  parseSandboxArtifactReply,
} from "./ipc-parsers";

export function registerSandboxArtifactIpc(bridge: RunnerIpcBridge): void {
  const windowListeners = new Map<string, () => void>();
  const removeWindow = (windowId: string): void => {
    bridge.sandboxArtifacts.dropWindow(windowId);
    windowListeners.get(windowId)?.();
    windowListeners.delete(windowId);
  };
  const observeWindow = (windowId: string, contents: WebContents): void => {
    if (windowListeners.has(windowId)) return;
    // Artifact-only windows need cleanup even when no browser session exists.
    const reset = (): void => bridge.sandboxArtifacts.dropWindow(windowId);
    const navigate = (
      _event: Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame && !isInPlace) reset();
    };
    const destroyed = (): void => removeWindow(windowId);
    contents.on("render-process-gone", reset);
    contents.on("did-start-navigation", navigate);
    contents.on("destroyed", destroyed);
    windowListeners.set(windowId, () => {
      contents.removeListener("render-process-gone", reset);
      contents.removeListener("did-start-navigation", navigate);
      contents.removeListener("destroyed", destroyed);
    });
  };
  const prune = (): void => {
    for (const windowId of windowListeners.keys()) {
      if (bridge.windowRegistry.getRecordById(windowId) === null)
        removeWindow(windowId);
    }
  };
  bridge.windowRegistry.on("change", prune);
  bridge.disposeFns.push(() => {
    bridge.windowRegistry.off("change", prune);
    for (const windowId of windowListeners.keys()) removeWindow(windowId);
  });
  bridge.handleInvoke(
    RunnerHostInvoke.sandboxArtifactRegister,
    (event, payload) => {
      const windowId = senderWindowId(bridge, event);
      bridge.sandboxArtifacts.register(
        parseSandboxArtifactMountId(payload),
        windowId,
      );
      observeWindow(windowId, event.sender);
    },
  );
  bridge.handleInvoke(
    RunnerHostInvoke.sandboxArtifactUnregister,
    (event, payload) => {
      const windowId = senderWindowId(bridge, event);
      const mountId = parseSandboxArtifactMountId(payload);
      if (bridge.sandboxArtifacts.ownsMount(mountId, windowId))
        bridge.sandboxArtifacts.unregister(mountId);
    },
  );
  bridge.handleInvoke(
    RunnerHostInvoke.sandboxArtifactRespond,
    (event, payload) => {
      const windowId = senderWindowId(bridge, event);
      const reply = parseSandboxArtifactReply(payload);
      if (reply !== null) bridge.sandboxArtifacts.respond(reply, windowId);
    },
  );
}

function senderWindowId(
  bridge: RunnerIpcBridge,
  event: IpcMainInvokeEvent,
): string {
  const windowId = bridge.resolveSenderWindowId(event);
  if (windowId === null)
    throw new Error("Artifact IPC sender window is not registered");
  return windowId;
}
