import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import type {
  SandboxBridgeHost,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
import { ArtifactPagesFrame } from "./artifact-pages-frame";
import { HtmlSelectionLayer } from "./html-selection-layer";
import { FrameCommentSurfaceProvider } from "@/components/comments/frame-comment-surface";
import {
  useHtmlSelectionStore,
  type HtmlSelection,
} from "./html-selection-store";

interface HtmlFrameDocument {
  readonly bridge: SandboxBridgeHost;
  readonly servedSha256: string | null;
}

export interface HtmlArtifactFrameContext {
  readonly frame: HTMLIFrameElement | null;
  readonly bridge: SandboxBridgeHost | null;
  readonly servedSha256: string | null;
}

const noop = (): void => undefined;

export function HtmlArtifactFrame(props: {
  readonly source: Extract<SandboxSource, { kind: "artifact" }>;
  readonly title: string;
  readonly selectable: boolean;
  readonly commentsEnabled: boolean;
  readonly actionControls?: (
    selection: HtmlSelection,
    context: HtmlArtifactFrameContext,
  ) => ReactNode;
  readonly renderComments?: (context: HtmlArtifactFrameContext) => ReactNode;
  readonly toolbarControls?: ReactNode;
}) {
  const { source } = props;
  const artifactId = source.artifactId;
  const selectable = props.selectable && props.commentsEnabled;
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [document, setDocument] = useState<HtmlFrameDocument | null>(null);
  const [ready, setReady] = useState(false);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  const onBridge = useCallback(
    (bridge: SandboxBridgeHost | null): void => {
      bridgeRef.current = bridge;
      setReady(false);
      useHtmlSelectionStore.getState().clearSelection(artifactId);
      setDocument(
        bridge === null
          ? null
          : {
              bridge,
              // Freeze the hash with the bridge that loaded these bytes. A new
              // manifest must not lend its hash to an answer from the previous frame.
              servedSha256: Object.hasOwn(
                source.manifest.files,
                source.entryPath,
              )
                ? source.manifest.files[source.entryPath].sha256
                : null,
            },
      );
    },
    [artifactId, source],
  );
  const onStatus = useCallback(
    (status: SandboxStatus): void => {
      setReady(status === "ready");
      if (status === "ready") {
        const enabled =
          selectable &&
          useHtmlSelectionStore.getState().byArtifact.get(artifactId)
            ?.enabled === true;
        void bridgeRef.current?.setMode(enabled ? "edit" : "play");
      } else {
        useHtmlSelectionStore.getState().clearSelection(artifactId);
      }
    },
    [artifactId, selectable],
  );
  useEffect(() => {
    if (!selectable) void bridgeRef.current?.setMode("play");
  }, [selectable]);
  const context: HtmlArtifactFrameContext = {
    frame,
    bridge: ready ? (document?.bridge ?? null) : null,
    servedSha256: document?.servedSha256 ?? null,
  };
  // Selection and comments are anchored to the entry page's bytes, so they
  // stand down while the reader is on another page of the artifact.
  const renderOverlay = (onEntryPage: boolean): ReactNode => (
    <>
      {selectable && onEntryPage ? (
        <HtmlSelectionLayer
          artifactId={artifactId}
          servedSha256={context.servedSha256}
          bridge={context.bridge}
          frame={frame}
          actionControls={(selection) =>
            props.actionControls?.(selection, context)
          }
          toolbarControls={props.toolbarControls}
        />
      ) : null}
      {onEntryPage ? props.renderComments?.(context) : null}
      {!selectable && onEntryPage ? (
        <div className="absolute right-2 top-2 z-30 rounded-md bg-popover">
          {props.toolbarControls}
        </div>
      ) : null}
    </>
  );
  return (
    <FrameCommentSurfaceProvider>
      <div className="h-full w-full">
        <ArtifactPagesFrame
          source={source}
          title={props.title}
          className="h-full w-full"
          height={null}
          onSize={noop}
          onStatus={onStatus}
          onBridge={onBridge}
          onTextSelection={(range) => {
            if (selectable && ready)
              useHtmlSelectionStore.getState().setTextRange(artifactId, range);
          }}
          onFrame={setFrame}
          renderOverlay={renderOverlay}
        />
      </div>
    </FrameCommentSurfaceProvider>
  );
}
