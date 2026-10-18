import { useCallback } from "react";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type {
  SandboxBridgeHost,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";

/** Frame messages are installed here by the element-selection/link track. */
export interface CanvasFrameEvents {
  readonly onBridge: (path: string, bridge: SandboxBridgeHost | null) => void;
  readonly onStatus: (path: string, status: SandboxStatus) => void;
  readonly onEditPointer: (
    path: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
}
const NO_PERMISSIONS = [] as const;
const noop = (): void => undefined;
export function CanvasBoardFrame({
  path,
  title,
  source,
  events,
  fullscreen,
}: {
  readonly path: string;
  readonly title: string;
  readonly source: SandboxSource;
  readonly events: CanvasFrameEvents | null;
  readonly fullscreen: boolean;
}) {
  const onBridge = useCallback(
    (bridge: SandboxBridgeHost | null) => events?.onBridge(path, bridge),
    [events, path],
  );
  const onStatus = useCallback(
    (status: SandboxStatus) => events?.onStatus(path, status),
    [events, path],
  );
  return (
    <SandboxFrame
      source={source}
      kind="page"
      title={title}
      appName={null}
      networkPolicy="https-only"
      appCsp={null}
      permissions={NO_PERMISSIONS}
      appRequests={null}
      className="h-full w-full"
      height={null}
      onSize={noop}
      onStatus={onStatus}
      onRequestTeardown={noop}
      displayMode={fullscreen ? "fullscreen" : "inline"}
      onBridge={onBridge}
      ref={null}
    />
  );
}
