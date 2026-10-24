import type { CanvasCommentView } from "./canvas-frame-registry";
import type { CanvasLayoutStore } from "./canvas-layout-store";
import { CanvasNodeContext } from "./canvas-node-context";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  SandboxFrame,
  type SandboxSource,
} from "@/components/sandbox/sandbox-frame";
import type {
  SandboxBridgeHost,
  SandboxSize,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import type {
  CanvasMode,
  CanvasPageError,
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";

export interface CanvasPanelControls {
  readonly onClose: () => void;
}
/** Selection and editing compose through these seams outside the opaque frame. */
export interface CanvasFrameEvents {
  readonly commentsEnabled?: boolean;
  readonly onCanvasView?: (view: CanvasCommentView | null) => void;
  readonly onPaneComment?: (point: {
    readonly x: number;
    readonly y: number;
  }) => void;
  readonly onSource?: (path: string, source: SandboxSource | null) => void;
  readonly onDoubleClick?: (path: string, element: CanvasElement) => void;
  readonly onBridge: (path: string, bridge: SandboxBridgeHost | null) => void;
  readonly onStatus: (path: string, status: SandboxStatus) => void;
  readonly onEditPointer: (
    path: string,
    point: { readonly x: number; readonly y: number },
  ) => void;
  readonly onBoardPage?: (path: string, page: string | null) => void;
  readonly onBoardSelect?: (path: string | null) => void;
  readonly onServedSource?: (path: string, sha256: string | null) => void;
  readonly onFrame?: (path: string, iframe: HTMLIFrameElement | null) => void;
  readonly onSize?: (path: string, size: SandboxSize) => void;
  readonly onTextSelection?: (
    path: string,
    selection: CanvasTextSelection | null,
  ) => void;
  readonly onPageError?: (path: string, error: CanvasPageError) => void;
  readonly onRelativeLink?: (path: string, href: string) => void;
  readonly onAddError?: (path: string, error: CanvasPageError) => void;
  /** Replaces the edit shield; must shield everything except the selected text. */
  readonly renderOverlay?: (path: string, editing: boolean) => ReactNode;
  /** The inspector; the editor shows it only while the person has it open. */
  readonly renderPanel?: (
    store: CanvasLayoutStore,
    panel: CanvasPanelControls,
  ) => ReactNode;
  /** Controls placed in the canvas's top-right toolbar pill (the comments list). */
  readonly renderToolbarControls?: () => ReactNode;
}
const NO_PERMISSIONS = [] as const;
const noop = (): void => undefined;
export function CanvasBoardFrame({
  path,
  title,
  source,
  events,
  fullscreen,
  mode,
  onError,
}: {
  readonly path: string;
  readonly title: string;
  readonly source: SandboxSource;
  readonly events: CanvasFrameEvents | null;
  readonly fullscreen: boolean;
  readonly mode: CanvasMode;
  readonly onError?: (error: CanvasPageError | null) => void;
}) {
  const actions = useContext(CanvasNodeContext);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const fittedPathRef = useRef<string | null>(null);
  useEffect(() => {
    events?.onSource?.(path, source);
    return () => events?.onSource?.(path, null);
  }, [events, path, source]);
  const onBridge = useCallback(
    (bridge: SandboxBridgeHost | null) => {
      bridgeRef.current = bridge;
      onError?.(null);
      let sha256: string | null = null;
      if (
        bridge !== null &&
        source.kind === "artifact" &&
        Object.hasOwn(source.manifest.files, path)
      )
        sha256 = source.manifest.files[path].sha256;
      events?.onServedSource?.(path, sha256);
      events?.onBridge(path, bridge);
    },
    [events, path, onError, source],
  );
  const onStatus = useCallback(
    (status: SandboxStatus) => {
      if (status === "ready") void bridgeRef.current?.setMode(mode);
      events?.onStatus(path, status);
    },
    [events, path, mode],
  );
  const onFrame = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      frameRef.current = iframe;
      events?.onFrame?.(path, iframe);
    },
    [events, path],
  );
  const onSize = useCallback(
    (size: SandboxSize) => {
      events?.onSize?.(path, size);
      if (
        fullscreen ||
        actions === null ||
        actions.viewOnly ||
        fittedPathRef.current === path ||
        size.height === null ||
        !Number.isFinite(size.height)
      )
        return;
      const viewportHeight = frameRef.current?.clientHeight ?? 0;
      if (viewportHeight <= 0) return;
      // A page sized to the viewport (100vh) reports exactly the frame's
      // height and has no intrinsic one, so it keeps the nominal 800. A taller
      // report is real overflowing content and is kept.
      const height =
        Math.abs(size.height - viewportHeight) <= 1 ? 800 : size.height;
      fittedPathRef.current = path;
      actions.fitBoardHeight(path, Math.max(60, height));
    },
    [actions, events, fullscreen, path],
  );
  useEffect(() => {
    void bridgeRef.current?.setMode(mode);
  }, [mode]);
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
      onSize={onSize}
      onStatus={onStatus}
      onRequestTeardown={noop}
      displayMode={fullscreen ? "fullscreen" : "inline"}
      pageNavigation={null}
      onBridge={onBridge}
      onDoubleClick={(element) => events?.onDoubleClick?.(path, element)}
      onTextSelection={(selection) =>
        events?.onTextSelection?.(path, selection)
      }
      onPageError={(error) => {
        onError?.(error);
        events?.onPageError?.(path, error);
      }}
      onRelativeLink={(href) => events?.onRelativeLink?.(path, href)}
      ref={onFrame}
    />
  );
}
