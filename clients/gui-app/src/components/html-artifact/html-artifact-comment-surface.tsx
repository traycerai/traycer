import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArtifactExpansion } from "@/components/artifacts/artifact-expansion";
import { useArtifactExpansion } from "@/components/artifacts/artifact-expanded-context";
import { CanvasFrameEventsContext } from "@/components/canvas-artifact/canvas-surface-context";
import type { CanvasFrameEvents } from "@/components/canvas-artifact/canvas-frame";
import type { CanvasCommentView } from "@/components/canvas-artifact/canvas-frame-registry";
import { CanvasSelectionProvider } from "@/components/canvas-artifact/canvas-selection-provider";
import { FrameCommentsUnavailable } from "@/components/comments/frame-comments";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { useFrameCommentsEnabled } from "@/hooks/comments/use-frame-comments-enabled";
import { artifactPagePaths } from "@/lib/sandbox/artifact-serving";
import type {
  SandboxBridgeHost,
  SandboxSize,
  SandboxStatus,
} from "@/lib/sandbox/bridge-host";
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

/**
 * The page sized the way its caller lays it out: a tile fills its panel
 * (`height` null), a chat card follows its page's own height.
 */
interface CommentFrameSizing {
  readonly height: number | null;
  readonly className: string;
  readonly onSize: (size: SandboxSize) => void;
  readonly onStatus: (status: SandboxStatus) => void;
}

export function HtmlArtifactCommentSurface(
  props: CommentFrameSizing & {
    readonly epicId: string;
    readonly artifactId: string;
    readonly artifactTitle: string;
    readonly hostId: string;
    readonly viewTabId: string;
    readonly source: ArtifactSource;
    /** Shown above the page, inline and expanded alike. */
    readonly caption: ReactNode;
    readonly toolbarControls: ReactNode;
    readonly menuItems: ReactNode;
    /**
     * Comments only while the surface is raised. A chat card's transcript row
     * clips whatever paints outside it, the comment draft included, so the
     * card raises itself to take a comment.
     */
    readonly raiseToComment: boolean;
  },
) {
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
        caption={props.caption}
        height={props.height}
        className={props.className}
        onSize={props.onSize}
        onStatus={props.onStatus}
        toolbarControls={props.toolbarControls}
        menuItems={props.menuItems}
        raiseToComment={props.raiseToComment}
      />
    </CanvasSelectionProvider>
  );
}

/**
 * Comments anchor to the live page, so an older version cannot take one. The
 * toggle stays in its place, unavailable, so the controls around it hold still.
 */
export function HtmlArtifactOlderVersionComments(props: {
  readonly viewTabId: string | null;
}) {
  const commentsEnabled = useFrameCommentsEnabled();
  if (props.viewTabId === null || !commentsEnabled) return null;
  return (
    <FrameCommentsUnavailable reason="Comments are on the latest version" />
  );
}

interface CommentFrameProps extends CommentFrameSizing {
  readonly source: ArtifactSource;
  readonly title: string;
  readonly caption: ReactNode;
  readonly toolbarControls: ReactNode;
  readonly menuItems: ReactNode;
  readonly raiseToComment: boolean;
}

function ProvidedCommentFrame(props: CommentFrameProps) {
  const events = useContext(CanvasFrameEventsContext);
  if (events === null) return null;
  return (
    // Around the draft as well as the frame: the draft is a sibling of the
    // frame, so an expansion raised inside the frame would leave it outside
    // the raised surface - portalled onto the pane or the body, behind an
    // inert document, invisible and unreachable. Inside here it portals into
    // the surface, and the menus it raises resolve their container from it.
    <ArtifactExpansion title={props.title}>
      <HtmlArtifactCommentFrame {...props} events={events} />
    </ArtifactExpansion>
  );
}

/**
 * The Comments mode the reader asked for, and the press that asks. A surface
 * that comments only while raised rises at a press made inline, stays off if
 * it cannot rise, and drops the mode as it lowers.
 */
function useCommentingRequest(
  raiseToComment: boolean,
): readonly [boolean, (enabled: boolean) => void] {
  const expansion = useArtifactExpansion();
  const expanded = expansion?.expanded ?? false;
  const [requested, setRequested] = useState(false);
  if (raiseToComment && !expanded && requested) setRequested(false);
  // Read at the press, not at render: the expansion hands out a fresh
  // `expand` with every render it makes.
  const expandRef = useRef<(() => boolean) | null>(null);
  const expand = expansion?.expand ?? null;
  useLayoutEffect(() => {
    expandRef.current = expand;
  }, [expand]);
  const request = useCallback(
    (enabled: boolean): void => {
      if (
        enabled &&
        raiseToComment &&
        !expanded &&
        expandRef.current?.() !== true
      )
        return;
      setRequested(enabled);
    },
    [raiseToComment, expanded],
  );
  return [requested, request];
}

function HtmlArtifactCommentFrame(
  props: CommentFrameProps & { readonly events: CanvasFrameEvents },
) {
  const { source, events } = props;
  const [commentingRequested, setCommenting] = useCommentingRequest(
    props.raiseToComment,
  );
  const commentsEnabled = events.commentsEnabled === true;
  // Derived, not reset: should the host stop serving comments while the mode
  // is on, the toggle goes and the shield must go with it, or the page would
  // stay blocked with nothing on screen to unblock it.
  const commenting = commentingRequested && commentsEnabled;
  const entryPath = source.entryPath === "" ? "index.html" : source.entryPath;
  // The board comments go on is the page the frame shows. The surface shows
  // one page at a time, so there is one board, and following a link moves it.
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
    [commenting, setCommenting, order, pageSources, page],
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
  // A new `events` (a renamed artifact, another host client) still files into
  // the same registry, so the board is told through the latest one rather
  // than filed again: filing again would drop the page's bridge for a moment,
  // and with it the revision its live document adopted.
  const tell = useEffectEvent(
    (call: (latest: CanvasFrameEvents) => void): void => call(events),
  );
  useEffect(() => {
    if (page === null) return;
    tell((latest) => {
      latest.onSource?.(page, boardSource);
      latest.onServedSource?.(page, servedSha256);
      latest.onBoardPage?.(page, null);
    });
    return () =>
      tell((latest) => {
        latest.onSource?.(page, null);
        latest.onServedSource?.(page, null);
      });
  }, [page, boardSource, servedSha256]);
  // Keyed by the proof, not the path: every document that proves itself is
  // filed afresh and told it is ready, so a page loaded again never keeps
  // what the provider held for the document before it, such as an adopted
  // revision.
  useEffect(() => {
    if (board === null) return;
    const { path } = board;
    tell((latest) => {
      latest.onFrame?.(path, frameRef.current);
      latest.onBridge(path, bridgeRef.current);
      latest.onStatus(path, "ready");
    });
    return () =>
      tell((latest) => {
        latest.onBridge(path, null);
        latest.onFrame?.(path, null);
      });
  }, [board]);
  return (
    <>
      {props.caption}
      <ArtifactPagesFrame
        ref={pagesFrame}
        source={served}
        title={props.title}
        className={props.className}
        height={props.height}
        commenting={commenting}
        onCommentPage={setBoard}
        onSize={props.onSize}
        // The caller's own watch (a crash). A page says it is ready before it
        // becomes the board, so the board effect above tells the comment
        // machinery instead.
        onStatus={props.onStatus}
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
    </>
  );
}
