import type { CanvasCommentView } from "./canvas-frame-registry";
import type { CanvasLayoutStore } from "./canvas-layout-store";
import { CanvasNodeContext } from "./canvas-node-context";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
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
  CanvasPanGesture,
  CanvasElement,
  CanvasTextSelection,
} from "@/lib/sandbox/canvas-bridge";

export interface CanvasPanelControls {
  readonly onClose: () => void;
}
/** Selection and editing compose through these seams outside the opaque frame. */
export interface CanvasFrameEvents {
  readonly onZoom?: (
    delta: number,
    point: { readonly x: number; readonly y: number },
  ) => void;
  /** A wheel gesture the playing board could not scroll by, handed over as a
   * canvas pan. */
  readonly onPan?: (gesture: CanvasPanGesture) => void;
  readonly commentsEnabled?: boolean;
  readonly onCanvasView?: (view: CanvasCommentView | null) => void;
  /** A comment-mode click on blank canvas: its screen spot for the composer,
   * and the canvas-space point on the page the pin is stored at. */
  readonly onPaneComment?: (point: {
    readonly screen: { readonly x: number; readonly y: number };
    readonly canvas: { readonly x: number; readonly y: number };
    readonly page: string;
  }) => void;
  /** The canvas-space comment pins laid over the page, outside every board. */
  readonly renderCanvasPins?: (
    page: string,
    viewport: { readonly x: number; readonly y: number; readonly zoom: number },
  ) => ReactNode;
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
  /**
   * Whether the live document already adopted this revision change in place
   * (a stamped tid), so the board must keep its mount instead of reloading.
   */
  readonly sourceAdopted?: (
    path: string,
    previousSha256: string,
    nextSha256: string,
  ) => boolean;
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
  readonly renderCommentDraft?: () => ReactNode;
  readonly renderCommentsSidebar?: () => ReactNode;
  /** The independent commenting-mode control. */
  readonly renderToolbarControls?: () => ReactNode;
}
const NO_PERMISSIONS = [] as const;
const noop = (): void => undefined;

/**
 * A manifest head moves on every file write in the artifact. A board reloads
 * only when a file its document can read changed: its own entry, or anything
 * outside the other boards and the layout file (a shared stylesheet or
 * asset). Even its own entry changing is absorbed when the live document
 * adopted the revision in place (a stamped comment tid).
 */
function sameBoardSourceIdentity(
  previous: Extract<SandboxSource, { kind: "artifact" }>,
  next: Extract<SandboxSource, { kind: "artifact" }>,
): boolean {
  return (
    previous.artifactId === next.artifactId &&
    previous.treePath === next.treePath &&
    previous.entryPath === next.entryPath &&
    previous.canvas === next.canvas &&
    previous.canvasLinks === next.canvasLinks &&
    previous.readSpan === next.readSpan &&
    Object.hasOwn(previous.manifest.files, previous.entryPath) &&
    Object.hasOwn(next.manifest.files, next.entryPath)
  );
}

function boardSourceEquivalent(
  previous: SandboxSource,
  next: SandboxSource,
  sourceAdopted: (beforeSha256: string, afterSha256: string) => boolean,
): "unchanged" | "adopted" | null {
  if (previous.kind !== "artifact" || next.kind !== "artifact") return null;
  if (!sameBoardSourceIdentity(previous, next)) return null;
  // Only other board DOCUMENTS are unrelated: a stylesheet or data file under
  // boards/ can be read by this board and must still invalidate it.
  const otherBoardOrLayout = (file: string): boolean =>
    file !== previous.entryPath &&
    (file === "canvas.json" ||
      (file.startsWith("boards/") && /\.html?$/i.test(file)));
  for (const file of new Set([
    ...Object.keys(previous.manifest.files),
    ...Object.keys(next.manifest.files),
  ])) {
    if (file === previous.entryPath || otherBoardOrLayout(file)) continue;
    const beforeSha = Object.hasOwn(previous.manifest.files, file)
      ? previous.manifest.files[file].sha256
      : null;
    const afterSha = Object.hasOwn(next.manifest.files, file)
      ? next.manifest.files[file].sha256
      : null;
    if (beforeSha !== afterSha) return null;
  }
  const before = previous.manifest.files[previous.entryPath].sha256;
  const after = next.manifest.files[next.entryPath].sha256;
  if (before === after) return "unchanged";
  return sourceAdopted(before, after) ? "adopted" : null;
}
export function CanvasBoardFrame({
  path,
  title,
  source,
  events,
  fullscreen,
  mode,
  onError,
  navigation,
}: {
  readonly path: string;
  readonly title: string;
  readonly source: SandboxSource;
  readonly events: CanvasFrameEvents | null;
  readonly fullscreen: boolean;
  readonly mode: CanvasMode;
  readonly onError?: (error: CanvasPageError | null) => void;
  readonly navigation?: {
    readonly search: string;
    readonly hash: string;
    readonly visit: number;
  } | null;
}) {
  const actions = useContext(CanvasNodeContext);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const appliedNavigation = useRef<typeof navigation>(null);
  // The live document adopted a revision in place, so its server mount still
  // holds the pre-adoption bytes.
  const adoptedDocument = useRef(false);
  const [remountEpoch, setRemountEpoch] = useState(0);
  const navigate = useCallback((): void => {
    const bridge = bridgeRef.current;
    // A cleared navigation entry (play stopped) discards wherever the played
    // document went: the board comes back as a fresh mount of its own source.
    if (navigation === null || navigation === undefined) {
      if (appliedNavigation.current !== null) {
        appliedNavigation.current = null;
        adoptedDocument.current = false;
        setRemountEpoch((epoch) => epoch + 1);
      }
      return;
    }
    if (bridge === null || navigation === appliedNavigation.current) return;
    // A query change reloads the document. An adopted document must not
    // reload from its stale mount: give it a fresh mount from the current
    // manifest, and apply the navigation once that document is ready.
    if (
      adoptedDocument.current &&
      navigation.search !== (appliedNavigation.current?.search ?? "")
    ) {
      adoptedDocument.current = false;
      setRemountEpoch((epoch) => epoch + 1);
      return;
    }
    void bridge.navigateCanvas(navigation).then((applied) => {
      if (applied && bridgeRef.current === bridge)
        appliedNavigation.current = navigation;
    });
  }, [navigation]);
  useEffect(navigate, [navigate]);
  const fittedPathRef = useRef<string | null>(null);
  useEffect(() => {
    events?.onSource?.(path, source);
    return () => events?.onSource?.(path, null);
  }, [events, path, source]);
  const onBridge = useCallback(
    (bridge: SandboxBridgeHost | null) => {
      bridgeRef.current = bridge;
      // A new bridge is a freshly served document: never adopted.
      if (bridge !== null) adoptedDocument.current = false;
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
      if (status === "ready") {
        void bridgeRef.current?.setMode(mode);
        navigate();
      }
      events?.onStatus(path, status);
    },
    [events, path, mode, navigate],
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
  const sourceEquivalent = useCallback(
    (previous: SandboxSource, next: SandboxSource): boolean => {
      const verdict = boardSourceEquivalent(
        previous,
        next,
        (before, after) =>
          events?.sourceAdopted?.(path, before, after) === true,
      );
      if (verdict === "adopted") adoptedDocument.current = true;
      return verdict !== null;
    },
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
      onSize={onSize}
      onStatus={onStatus}
      onRequestTeardown={noop}
      displayMode={fullscreen ? "fullscreen" : "inline"}
      pageNavigation={null}
      onBridge={onBridge}
      sourceEquivalent={sourceEquivalent}
      remountKey={String(remountEpoch)}
      onDoubleClick={(element) => events?.onDoubleClick?.(path, element)}
      onTextSelection={(selection) =>
        events?.onTextSelection?.(path, selection)
      }
      onPageError={(error) => {
        onError?.(error);
        events?.onPageError?.(path, error);
      }}
      onCanvasZoom={(gesture) => {
        const frame = frameRef.current;
        if (frame === null || fullscreen) return;
        const bounds = frame.getBoundingClientRect();
        events?.onZoom?.(gesture.delta, {
          x: bounds.left + (gesture.x * bounds.width) / frame.clientWidth,
          y: bounds.top + (gesture.y * bounds.height) / frame.clientHeight,
        });
      }}
      onCanvasPan={(gesture) => {
        if (!fullscreen) events?.onPan?.(gesture);
      }}
      onRelativeLink={(href) => events?.onRelativeLink?.(path, href)}
      ref={onFrame}
    />
  );
}
