import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { CanvasFrameEventsContext } from "@/components/canvas-artifact/canvas-surface-context";
import type { CanvasFrameEvents } from "@/components/canvas-artifact/canvas-frame";
import type { CanvasCommentView } from "@/components/canvas-artifact/canvas-frame-registry";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { ArtifactPagesFrame } from "./artifact-pages-frame";

const noop = (): void => undefined;

type ArtifactSource = Extract<SandboxSource, { kind: "artifact" }>;

function samePageSourceIdentity(
  previous: ArtifactSource,
  next: ArtifactSource,
  entryPath: string,
): boolean {
  return (
    previous.artifactId === next.artifactId &&
    previous.treePath === next.treePath &&
    previous.entryPath === next.entryPath &&
    previous.canvas === next.canvas &&
    previous.canvasLinks === next.canvasLinks &&
    previous.readSpan === next.readSpan &&
    previous.resolveOutsideReference === next.resolveOutsideReference &&
    Object.hasOwn(previous.manifest.files, entryPath) &&
    Object.hasOwn(next.manifest.files, entryPath)
  );
}

/** A page can read any file in its folder, so every other file must match. */
function otherFilesUnchanged(
  previous: ArtifactSource,
  next: ArtifactSource,
  entryPath: string,
): boolean {
  const shaOf = (source: ArtifactSource, file: string): string | null =>
    Object.hasOwn(source.manifest.files, file)
      ? source.manifest.files[file].sha256
      : null;
  for (const file of new Set([
    ...Object.keys(previous.manifest.files),
    ...Object.keys(next.manifest.files),
  ])) {
    if (file !== entryPath && shaOf(previous, file) !== shaOf(next, file))
      return false;
  }
  return true;
}

/**
 * Whether a replacement source can keep the mounted page: the entry's own
 * bytes may change only when the live document adopted that revision in
 * place (a first comment's stamped id), which is what the provider's
 * `sourceAdopted` answers. Anything else is a reload.
 */
function pageSourceEquivalent(
  previous: SandboxSource,
  next: SandboxSource,
  entryPath: string,
  sourceAdopted: (beforeSha256: string, afterSha256: string) => boolean,
): boolean {
  if (
    previous.kind !== "artifact" ||
    next.kind !== "artifact" ||
    !samePageSourceIdentity(previous, next, entryPath) ||
    !otherFilesUnchanged(previous, next, entryPath)
  )
    return false;
  const before = previous.manifest.files[entryPath].sha256;
  const after = next.manifest.files[entryPath].sha256;
  return before === after || sourceAdopted(before, after);
}

export function HtmlArtifactCommentSurface(props: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactTitle: string;
  readonly hostId: string;
  readonly viewTabId: string;
  readonly source: ArtifactSource;
  readonly toolbarControls: ReactNode;
}) {
  return (
    <CanvasSelectionProvider
      epicId={props.epicId}
      artifactId={props.artifactId}
      artifactTitle={props.artifactTitle}
      artifactType="html"
      hostId={props.hostId}
      viewTabId={props.viewTabId}
    >
      <ProvidedCommentFrame
        source={props.source}
        title={props.artifactTitle}
        toolbarControls={props.toolbarControls}
      />
    </CanvasSelectionProvider>
  );
}

interface CommentFrameProps {
  readonly source: ArtifactSource;
  readonly title: string;
  readonly toolbarControls: ReactNode;
}

function ProvidedCommentFrame(props: CommentFrameProps) {
  const events = useContext(CanvasFrameEventsContext);
  if (events === null) return null;
  return <HtmlArtifactCommentFrame {...props} events={events} />;
}

function HtmlArtifactCommentFrame(
  props: CommentFrameProps & { readonly events: CanvasFrameEvents },
) {
  const { source, events } = props;
  const [commentingRequested, setCommenting] = useState(false);
  const commentsEnabled = events.commentsEnabled === true;
  // Derived, not reset: should the host stop serving comments while the mode
  // is on, the toggle goes and the shield must go with it, or the page would
  // stay blocked with nothing on screen to unblock it.
  const commenting = commentingRequested && commentsEnabled;
  const path = source.entryPath === "" ? "index.html" : source.entryPath;
  const files = source.manifest.files;
  const servedSha256 = Object.hasOwn(files, path) ? files[path].sha256 : null;
  const served = useMemo<ArtifactSource>(
    () =>
      commenting
        ? { ...source, canvas: true, canvasLinks: "native" }
        : source,
    [source, commenting],
  );
  const view = useMemo<CanvasCommentView>(
    () => ({
      tool: commenting ? "comment" : "select",
      play: true,
      commenting,
      setCommenting,
      order: [path],
      sourceForBoard: (board) => (board === path ? served : null),
      // The one page is always showing; a thread's reveal only needs the
      // mode on, and the pins then mark it.
      revealBoard: (board) => board === path,
      revealCanvasPoint: () => false,
      clearNodeSelection: noop,
    }),
    [commenting, path, served],
  );
  const sourceEquivalent = useCallback(
    (previous: SandboxSource, next: SandboxSource): boolean =>
      pageSourceEquivalent(
        previous,
        next,
        path,
        (before, after) => events.sourceAdopted?.(path, before, after) === true,
      ),
    [events, path],
  );
  useEffect(() => {
    events.onCanvasView?.(view);
    return () => events.onCanvasView?.(null);
  }, [events, view]);
  useEffect(() => {
    events.onSource?.(path, served);
    events.onServedSource?.(path, servedSha256);
    events.onBoardPage?.(path, null);
    return () => {
      events.onSource?.(path, null);
      events.onServedSource?.(path, null);
    };
  }, [events, path, served, servedSha256]);
  return (
    <>
      <ArtifactPagesFrame
        source={served}
        title={props.title}
        className="h-full w-full"
        height={null}
        pageZoom={!commenting}
        onSize={noop}
        onStatus={(status) => events.onStatus(path, status)}
        onBridge={(bridge) => events.onBridge(path, bridge)}
        onTextSelection={(selection) =>
          events.onTextSelection?.(path, selection)
        }
        onFrame={(frame) => events.onFrame?.(path, frame)}
        renderOverlay={(onEntryPage) =>
          commenting && onEntryPage
            ? events.renderOverlay?.(path, true)
            : null
        }
        sourceEquivalent={sourceEquivalent}
        toolbarControls={
          <>
            {props.toolbarControls}
            {commentsEnabled ? events.renderToolbarControls?.() : null}
          </>
        }
      />
      {events.renderCommentDraft?.()}
    </>
  );
}
