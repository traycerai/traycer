import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import { CanvasFrameEventsContext } from "@/components/canvas-artifact/canvas-surface-context";
import type { CanvasFrameEvents } from "@/components/canvas-artifact/canvas-frame";
import type { CanvasCommentView } from "@/components/canvas-artifact/canvas-frame-registry";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { artifactPagePaths } from "@/lib/sandbox/artifact-serving";
import type { SandboxBridgeHost } from "@/lib/sandbox/bridge-host";
import {
  ArtifactPagesFrame,
  type ArtifactPagesNavigator,
  type ProvenPage,
} from "./artifact-pages-frame";

const noop = (): void => undefined;

type ArtifactSource = Extract<SandboxSource, { kind: "artifact" }>;

function sameServedArtifact(
  previous: ArtifactSource,
  next: ArtifactSource,
): boolean {
  return (
    previous.artifactId === next.artifactId &&
    previous.treePath === next.treePath &&
    previous.entryPath === next.entryPath &&
    previous.readSpan === next.readSpan &&
    previous.resolveOutsideReference === next.resolveOutsideReference
  );
}

/** A page can read any file in its folder, so every other file must match. */
function otherFilesUnchanged(
  previous: ArtifactSource,
  next: ArtifactSource,
  page: string | null,
): boolean {
  const shaOf = (source: ArtifactSource, file: string): string | null =>
    Object.hasOwn(source.manifest.files, file)
      ? source.manifest.files[file].sha256
      : null;
  for (const file of new Set([
    ...Object.keys(previous.manifest.files),
    ...Object.keys(next.manifest.files),
  ])) {
    if (file !== page && shaOf(previous, file) !== shaOf(next, file))
      return false;
  }
  return true;
}

/**
 * Whether a replacement source can keep the mounted page: the bytes of the
 * page on show may change only when its live document adopted that revision
 * in place (a first comment's stamped id), which is what the provider's
 * `sourceAdopted` answers. Anything else is a reload, and with none of the
 * artifact's pages on show, any change at all is.
 */
function pageSourceEquivalent(
  previous: SandboxSource,
  next: SandboxSource,
  page: string | null,
  sourceAdopted: (beforeSha256: string, afterSha256: string) => boolean,
): boolean {
  if (
    previous.kind !== "artifact" ||
    next.kind !== "artifact" ||
    !sameServedArtifact(previous, next) ||
    !otherFilesUnchanged(previous, next, page)
  )
    return false;
  if (page === null) return true;
  if (
    !Object.hasOwn(previous.manifest.files, page) ||
    !Object.hasOwn(next.manifest.files, page)
  )
    return false;
  const before = previous.manifest.files[page].sha256;
  const after = next.manifest.files[page].sha256;
  return before === after || sourceAdopted(before, after);
}

/**
 * The artifact's pages, entry first, each read as a board of its own the way
 * a canvas's boards are: a comment names the page it is on, and the comments
 * panel numbers and places every page's threads, not only the one on show.
 */
function pageSourcesFor(
  served: ArtifactSource,
  entryPath: string,
): ReadonlyMap<string, ArtifactSource> {
  const pages = artifactPagePaths(served.manifest).toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ordered = pages.includes(entryPath)
    ? [entryPath, ...pages.filter((page) => page !== entryPath)]
    : pages;
  return new Map(ordered.map((page) => [page, { ...served, entryPath: page }]));
}

export function HtmlArtifactCommentSurface(props: {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactTitle: string;
  readonly hostId: string;
  readonly viewTabId: string;
  readonly source: ArtifactSource;
  readonly toolbarControls: ReactNode;
  readonly menuItems: ReactNode;
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
        menuItems={props.menuItems}
      />
    </CanvasSelectionProvider>
  );
}

interface CommentFrameProps {
  readonly source: ArtifactSource;
  readonly title: string;
  readonly toolbarControls: ReactNode;
  readonly menuItems: ReactNode;
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
  const entryPath = source.entryPath === "" ? "index.html" : source.entryPath;
  // The board comments go on is the page the frame shows. The tile shows one
  // page at a time, so there is one board, and following a link moves it.
  const [board, setBoard] = useState<ProvenPage | null>(null);
  const page = board?.path ?? null;
  const pagesFrame = useRef<ArtifactPagesNavigator>(null);
  // The iframe and its bridge outlast a move between pages, so they are
  // filed under whichever page is the board.
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<SandboxBridgeHost | null>(null);
  // One document for reading and commenting: the comment tool is a mode the
  // loaded page is told to take, so the reader's scroll and zoom and the
  // page's own state outlast turning it on or off.
  const served = useMemo<ArtifactSource>(
    () => ({ ...source, canvas: true, canvasLinks: "native" }),
    [source],
  );
  const pageSources = useMemo(
    () => pageSourcesFor(served, entryPath),
    [served, entryPath],
  );
  const order = useMemo(() => [...pageSources.keys()], [pageSources]);
  const view = useMemo<CanvasCommentView>(
    () => ({
      tool: commenting ? "comment" : "select",
      play: true,
      commenting,
      setCommenting,
      order,
      sourceForBoard: (path) => pageSources.get(path) ?? null,
      // A thread on another page opens that page as a link would, so Back
      // returns from it. Its pins and its selection follow once that page has
      // proved itself and become the board.
      revealBoard: (path) => {
        if (!pageSources.has(path)) return false;
        if (path !== page) pagesFrame.current?.openPage(path);
        return true;
      },
      revealCanvasPoint: () => false,
      clearNodeSelection: noop,
    }),
    [commenting, order, pageSources, page],
  );
  const boardSource = page === null ? null : (pageSources.get(page) ?? null);
  const servedSha256 =
    page === null || boardSource === null
      ? null
      : boardSource.manifest.files[page].sha256;
  const sourceEquivalent = useCallback(
    (previous: SandboxSource, next: SandboxSource): boolean =>
      pageSourceEquivalent(
        previous,
        next,
        page,
        (before, after) =>
          page !== null && events.sourceAdopted?.(page, before, after) === true,
      ),
    [events, page],
  );
  useEffect(() => {
    events.onCanvasView?.(view);
    return () => events.onCanvasView?.(null);
  }, [events, view]);
  useEffect(() => {
    if (page === null) return;
    events.onSource?.(page, boardSource);
    events.onServedSource?.(page, servedSha256);
    events.onBoardPage?.(page, null);
    return () => {
      events.onSource?.(page, null);
      events.onServedSource?.(page, null);
    };
  }, [events, page, boardSource, servedSha256]);
  // Keyed by the proof, not the path: every document that proves itself is
  // filed afresh, so a page loaded again never keeps what the provider held
  // for the document before it, such as an adopted revision.
  useEffect(() => {
    if (board === null) return;
    events.onFrame?.(board.path, frameRef.current);
    events.onBridge(board.path, bridgeRef.current);
    return () => {
      events.onBridge(board.path, null);
      events.onFrame?.(board.path, null);
    };
  }, [events, board]);
  return (
    // Around the draft as well as the frame: the draft is a sibling of the
    // frame, so an expansion raised inside the frame would leave it outside
    // the raised surface - portalled onto the pane or the body, behind an
    // inert document, invisible and unreachable. Inside here it portals into
    // the surface, and the menus it raises resolve their container from it.
    <ArtifactExpansion title={props.title}>
      <ArtifactPagesFrame
        ref={pagesFrame}
        source={served}
        title={props.title}
        className="h-full w-full"
        height={null}
        commenting={commenting}
        onCommentPage={setBoard}
        onSize={noop}
        onStatus={(status) => {
          if (page !== null) events.onStatus(page, status);
        }}
        onBridge={(bridge) => {
          bridgeRef.current = bridge;
        }}
        onTextSelection={(selection) => {
          if (page !== null) events.onTextSelection?.(page, selection);
        }}
        onFrame={(frame) => {
          frameRef.current = frame;
        }}
        overlay={
          commenting && page !== null ? (
            // A fresh overlay per page: its outlines and pins belong to the
            // page they were drawn for.
            <Fragment key={page}>{events.renderOverlay?.(page, true)}</Fragment>
          ) : null
        }
        sourceEquivalent={sourceEquivalent}
        toolbarControls={
          <>
            {props.toolbarControls}
            {commentsEnabled ? events.renderToolbarControls?.() : null}
          </>
        }
        menuItems={props.menuItems}
      />
      {events.renderCommentDraft?.()}
    </ArtifactExpansion>
  );
}
