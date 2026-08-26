import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { BrowserScreencastServerFrame } from "@traycer/protocol/host/browser/contracts";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { BrowserViewBridge } from "@traycer-clients/shared/platform/browser-view";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostStreamClientFor } from "@/hooks/host/use-host-stream-client-for";
import {
  useElectronTabBindingOnHost,
  type ElectronTabBinding,
} from "@/lib/browser-view/electron-tabs";
import {
  openPipHeadlessStream,
  PIP_HEADLESS_MAX_HEIGHT,
  PIP_HEADLESS_MAX_WIDTH,
  PIP_HEADLESS_QUALITY,
} from "@/lib/browser-view/pip-headless-stream";
import {
  applyPipStreamHealth,
  completePipConversion,
  failPipConversion,
  type PipSnapshot,
  type PipTarget,
} from "@/lib/browser-view/pip-store";
import { useStreamAuthRevalidator } from "@/lib/host/stream-auth-revalidator";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";

interface OwnedPipFrame {
  readonly selectionId: string;
  readonly src: string;
}

export function usePipOwnedFrame(
  epicId: string,
  snapshot: PipSnapshot,
): string | null {
  const runnerHost = useRunnerHostOrNull();
  const {
    captureTarget,
    displayedSelectionId,
    hostId,
    selectionId,
    sessionId,
    tabId,
  } = pipCaptureCoordinates(snapshot);
  const binding = useElectronTabBindingOnHost(sessionId, tabId, hostId);
  const hostEntry = useHostDirectoryEntry(hostId);
  const auth = useStreamAuthRevalidator();
  const client = useHostStreamClientFor(
    captureTarget === null ? null : hostEntry,
    auth,
  );
  const bridge = runnerHost?.browserView ?? null;
  const useNative = binding !== null && bridge !== null;
  const enabled = captureTarget !== null;
  const { owned, setOwned } = usePipFrameOwner(
    displayedSelectionId,
    selectionId,
  );
  const clientHandle = usePipHostClientHandle(client);

  usePipNativeCaptureArm({
    binding,
    bridge,
    selectionId,
    enabled: enabled && useNative,
    epicId,
    setOwned,
  });
  usePipHeadlessCaptureArm({
    selectionId,
    clientHandle,
    enabled: enabled && !useNative && sessionId.length > 0 && tabId.length > 0,
    epicId,
    hostId,
    sessionId,
    setOwned,
    tabId,
  });

  return frameSrcFor(owned, displayedSelectionId);
}

interface PipHostClientHandle {
  readonly get: () => IHostStreamClient<HostStreamRpcRegistry> | null;
  readonly subscribe: (onChange: () => void) => () => void;
}

function pipCaptureCoordinates(snapshot: PipSnapshot): {
  readonly captureTarget: PipTarget | null;
  readonly displayedSelectionId: string | null;
  readonly hostId: string;
  readonly selectionId: string | null;
  readonly sessionId: string;
  readonly tabId: string;
} {
  const captureTarget = snapshot.pendingTarget ?? snapshot.target;
  return {
    captureTarget,
    displayedSelectionId: snapshot.target?.selectionId ?? null,
    hostId: captureTarget?.hostId ?? "",
    selectionId: captureTarget?.selectionId ?? null,
    sessionId: captureTarget?.sessionId ?? "",
    tabId: captureTarget?.tabId ?? "",
  };
}

function usePipHostClientHandle(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
): PipHostClientHandle {
  const storeRef = useRef<{
    client: IHostStreamClient<HostStreamRpcRegistry> | null;
    readonly listeners: Set<() => void>;
  }>({
    client,
    listeners: new Set(),
  });
  const [handle] = useState<PipHostClientHandle>(() => ({
    get: () => storeRef.current.client,
    subscribe: (onChange) => {
      storeRef.current.listeners.add(onChange);
      return () => {
        storeRef.current.listeners.delete(onChange);
      };
    },
  }));

  useEffect(() => {
    const store = storeRef.current;
    if (store.client === client) return;
    store.client = client;
    for (const listener of store.listeners) listener();
  });

  return handle;
}

function nativeTabBindingKey(binding: ElectronTabBinding): string {
  return [
    binding.hostId,
    binding.sessionId,
    binding.tabId,
    binding.registrationId,
  ].join("\u001f");
}

function usePipNativeCaptureArm(input: {
  readonly enabled: boolean;
  readonly binding: ElectronTabBinding | null;
  readonly bridge: BrowserViewBridge | null;
  readonly selectionId: string | null;
  readonly epicId: string;
  readonly setOwned: Dispatch<SetStateAction<OwnedPipFrame | null>>;
}): void {
  const tileKey =
    input.enabled && input.binding !== null
      ? `${nativeTabBindingKey(input.binding)}\u001f${input.selectionId ?? ""}`
      : null;
  const argsRef = useRef(input);
  useEffect(() => {
    argsRef.current = input;
  });
  useEffect(() => {
    if (tileKey === null) return;
    const args = argsRef.current;
    if (
      args.binding === null ||
      args.bridge === null ||
      args.selectionId === null
    ) {
      return;
    }
    const liveSelectionId = args.selectionId;
    return startNativePipCapture({
      binding: args.binding,
      bridge: args.bridge,
      epicId: args.epicId,
      selectionId: liveSelectionId,
      onUrl: (src) => {
        args.setOwned((prev) => {
          if (prev !== null && prev.src !== src) URL.revokeObjectURL(prev.src);
          return { selectionId: liveSelectionId, src };
        });
      },
    });
  }, [tileKey]);
}

function usePipHeadlessCaptureArm(input: {
  readonly enabled: boolean;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly selectionId: string | null;
  readonly epicId: string;
  readonly clientHandle: PipHostClientHandle;
  readonly setOwned: Dispatch<SetStateAction<OwnedPipFrame | null>>;
}): void {
  const latchKey = input.enabled
    ? [
        input.hostId,
        input.sessionId,
        input.tabId,
        input.selectionId ?? "",
      ].join("\u001f")
    : null;
  const argsRef = useRef(input);
  useEffect(() => {
    argsRef.current = input;
  });
  useEffect(() => {
    if (latchKey === null) return;
    const handle = argsRef.current.clientHandle;
    let disposed = false;
    let closeStream: (() => void) | undefined;
    let openedInstanceId: string | null = null;

    const sync = (): void => {
      if (disposed) return;
      const args = argsRef.current;
      const next = handle.get();
      const nextId = next === null ? null : next.instanceId;
      if (nextId === openedInstanceId) return;
      closeStream?.();
      closeStream = undefined;
      openedInstanceId = nextId;
      if (next === null || args.selectionId === null) return;
      const liveSelectionId = args.selectionId;
      closeStream = startHeadlessPipCapture({
        client: next,
        epicId: args.epicId,
        selectionId: liveSelectionId,
        onUrl: (src) => {
          args.setOwned((prev) => {
            if (prev !== null && prev.src !== src)
              URL.revokeObjectURL(prev.src);
            return { selectionId: liveSelectionId, src };
          });
        },
        sessionId: args.sessionId,
        tabId: args.tabId,
      });
    };

    const unsubscribe = handle.subscribe(sync);
    sync();
    return () => {
      disposed = true;
      unsubscribe();
      closeStream?.();
    };
  }, [latchKey]);
}

function frameSrcFor(
  owned: OwnedPipFrame | null,
  selectionId: string | null,
): string | null {
  if (owned === null || selectionId === null) return null;
  if (owned.selectionId !== selectionId) return null;
  return owned.src;
}

function usePipFrameOwner(
  displayedSelectionId: string | null,
  captureSelectionId: string | null,
): {
  readonly owned: OwnedPipFrame | null;
  readonly setOwned: Dispatch<SetStateAction<OwnedPipFrame | null>>;
} {
  const [owned, setOwned] = useState<OwnedPipFrame | null>(null);
  const ownedRef = useRef<OwnedPipFrame | null>(null);

  useEffect(() => {
    ownedRef.current = owned;
  }, [owned]);

  useEffect(() => {
    const current = ownedRef.current;
    if (current === null) return;
    if (
      current.selectionId === displayedSelectionId ||
      current.selectionId === captureSelectionId
    ) {
      return;
    }
    URL.revokeObjectURL(current.src);
    ownedRef.current = null;
    setOwned(null);
  }, [captureSelectionId, displayedSelectionId, setOwned]);

  useEffect(() => {
    return () => {
      const current = ownedRef.current;
      if (current !== null) URL.revokeObjectURL(current.src);
    };
  }, []);

  return { owned, setOwned };
}

function startNativePipCapture(input: {
  readonly binding: ElectronTabBinding;
  readonly bridge: BrowserViewBridge;
  readonly epicId: string;
  readonly selectionId: string;
  readonly onUrl: (src: string) => void;
}): () => void {
  let disposed = false;
  const applyFrame = (
    frame: BrowserScreencastServerFrame,
    jpegBytes: Uint8Array | null,
  ): void => {
    if (disposed) return;
    applyCaptureFrame({
      epicId: input.epicId,
      selectionId: input.selectionId,
      frame,
      jpegBytes,
      onUrl: input.onUrl,
    });
  };
  const subscription = input.bridge.onPipCaptureFrame(applyFrame);
  void input.bridge
    .startPipCapture({
      hostId: input.binding.hostId,
      sessionId: input.binding.sessionId,
      tabId: input.binding.tabId,
      registrationId: input.binding.registrationId,
      maxWidth: PIP_HEADLESS_MAX_WIDTH,
      maxHeight: PIP_HEADLESS_MAX_HEIGHT,
      quality: PIP_HEADLESS_QUALITY,
    })
    .catch((error: unknown) => {
      failPipConversion(
        input.epicId,
        input.selectionId,
        error instanceof Error ? error.message : "Picture in picture failed.",
      );
    });
  return () => {
    disposed = true;
    subscription.dispose();
    void input.bridge.stopPipCapture();
  };
}

function startHeadlessPipCapture(input: {
  readonly client: IHostStreamClient<HostStreamRpcRegistry>;
  readonly epicId: string;
  readonly selectionId: string;
  readonly onUrl: (src: string) => void;
  readonly sessionId: string;
  readonly tabId: string;
}): () => void {
  let disposed = false;
  const stream = openPipHeadlessStream({
    client: input.client,
    epicId: input.epicId,
    sessionId: input.sessionId,
    tabId: input.tabId,
    maxWidth: PIP_HEADLESS_MAX_WIDTH,
    maxHeight: PIP_HEADLESS_MAX_HEIGHT,
    quality: PIP_HEADLESS_QUALITY,
    onFrame: (frame, jpegBytes) => {
      if (disposed) return;
      applyCaptureFrame({
        epicId: input.epicId,
        selectionId: input.selectionId,
        frame,
        jpegBytes,
        onUrl: input.onUrl,
      });
    },
  });
  return () => {
    disposed = true;
    stream.close();
  };
}

function applyCaptureFrame(input: {
  readonly epicId: string;
  readonly selectionId: string;
  readonly frame: BrowserScreencastServerFrame;
  readonly jpegBytes: Uint8Array | null;
  readonly onUrl: (url: string) => void;
}): void {
  if (input.frame.kind === "stalled") {
    applyPipStreamHealth(input.epicId, input.selectionId, "stale");
    return;
  }
  if (input.frame.kind === "failed") {
    failPipConversion(input.epicId, input.selectionId, input.frame.reason);
    applyPipStreamHealth(input.epicId, input.selectionId, "disconnected");
    return;
  }
  if (input.frame.kind === "complete") {
    failPipConversion(
      input.epicId,
      input.selectionId,
      "The browser preview ended before picture in picture was ready.",
    );
    applyPipStreamHealth(input.epicId, input.selectionId, "disconnected");
    return;
  }
  if (input.frame.kind !== "frame" || input.jpegBytes === null) return;
  applyPipStreamHealth(input.epicId, input.selectionId, "live");
  const bytes = new Uint8Array(input.jpegBytes);
  const blob = new Blob([bytes], { type: "image/jpeg" });
  input.onUrl(URL.createObjectURL(blob));
  completePipConversion(input.epicId, input.selectionId);
}
