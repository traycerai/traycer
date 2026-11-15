import type { TerminalStreamCallbacks } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import type { TerminalViewersFrame } from "@traycer/protocol/host/terminal/subscribe";

export interface TerminalViewerTestSession {
  readonly handle: TerminalSessionStoreHandle;
  readonly emitViewers: (
    userIds: ReadonlyArray<string>,
    sessionId: string,
  ) => void;
  readonly dispose: () => void;
}

export function createTerminalViewerTestSession(
  instanceId: string,
  hostId: string,
  sessionId: string,
): TerminalViewerTestSession {
  let callbacks: TerminalStreamCallbacks | null = null;
  const createdHandle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-viewers-test" },
    sessionId,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal",
    viewer: "presentation",
    streamClientFactory: (args) => {
      callbacks = args.callbacks;
      return {
        sendAction: (_frame) => undefined,
        supportsViewerFrames: () => true,
        close: () => undefined,
      };
    },
  });
  const registry = getTerminalSessionRegistry();
  const handle = registry.acquire(
    instanceId,
    () => createdHandle,
    hostId,
    "presentation",
  );
  const readCallbacks = (): TerminalStreamCallbacks => {
    if (callbacks === null) {
      throw new Error("Expected terminal stream callbacks");
    }
    return callbacks;
  };
  return {
    handle,
    emitViewers: (userIds, frameSessionId) => {
      const frame: TerminalViewersFrame = {
        kind: "viewers",
        hasBinaryPayload: false,
        sessionId: frameSessionId,
        viewers: userIds.map((userId) => ({ userId })),
      };
      readCallbacks().onViewers(frame);
    },
    dispose: () => registry.release(instanceId, handle, false),
  };
}
