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
} from "@/lib/browser-view/sessions/electron-tabs";
import {
  openPipHeadlessStream,
  PIP_HEADLESS_MAX_HEIGHT,
  PIP_HEADLESS_MAX_WIDTH,
  PIP_HEADLESS_QUALITY,
} from "@/lib/browser-view/pip/pip-headless-stream";
import {
  applyPipStreamHealth,
  completePipConversion,
  failPipConversion,
  type PipSnapshot,
  type PipTarget,
} from "@/lib/browser-view/pip/pip-store";
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
  const enabled = captureTarget !== null;
  const { owned, setOwned } = usePipFrameOwner(
    displayedSelectionId,
    selectionId,
  );

  // One arm for both transports. Every value below is render-stable (the
  // binding comes from the Electron-tab directory store, the client from the
  // stream-client cache), so this is the real capture identity rather than a
  // string proxy for it.
  useEffect(() => {
    if (!enabled || selectionId === null) return;
    const onUrl = (src: string): void => {
      setOwned((previous) => {
        if (previous !== null && previous.src !== src) {
          URL.revokeObjectURL(previous.src);
        }
        return { selectionId, src };
      });
    };
    if (binding !== null && bridge !== null) {
      return startNativePipCapture({
        binding,
        bridge,
        epicId,
        selectionId,
        onUrl,
      });
    }
    if (client === null || sessionId.length === 0 || tabId.length === 0) return;
    return startHeadlessPipCapture({
      client,
      epicId,
      selectionId,
      onUrl,
      sessionId,
      tabId,
    });
  }, [
    binding,
    bridge,
    client,
    enabled,
    epicId,
    selectionId,
    sessionId,
    setOwned,
    tabId,
  ]);

  return frameSrcFor(owned, displayedSelectionId);
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
