import {
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

/**
 * The HTML artifact tile with its Comments toggle. The page is one board to
 * the comment machinery: the selection provider that serves canvas boards
 * serves it too, keyed by the entry page, so a click in comment mode opens
 * the same draft box with Comment and Send to chat.
 *
 * Comment mode swaps the served document for one carrying the element bridge
 * (hit testing, element descriptions, the text-selection target) the plain
 * page viewer does not have. That is a reload of the frame, so the toggle is
 * the moment page state is lost, not the first click.
 */
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
  const [commenting, setCommenting] = useState(false);
  const path = source.entryPath === "" ? "index.html" : source.entryPath;
  const files = source.manifest.files;
  const servedSha256 = Object.hasOwn(files, path) ? files[path].sha256 : null;
  const commentsEnabled = events.commentsEnabled === true;
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
