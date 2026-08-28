import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
} from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import { type EpicArtifactKind } from "@traycer/protocol/common/registry";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { usePanePortalContainer } from "@/components/epic-tabs/pane-visibility-context";
import type { HostRpcRegistry } from "@/lib/host";
import { useEpicCommentThreadsForClient } from "@/hooks/comments/use-epic-comment-threads";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { CommentContent } from "./comment-content-renderer";
import { deriveInitials } from "./mention-utils";

const HOVER_DELAY_MS = 300;

export interface ThreadAnchorHoverPopoverProps {
  readonly epicId: string;
  /** The TILE's client, handed down by `collab-tile-body.tsx`. It must be the
   *  same one the tile's own threads query used or this cache-only read
   *  (`enabled: false`) lands on a different host's key and never resolves a
   *  thread (D15). */
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly artifactType: EpicArtifactKind;
  readonly artifactId: string;
  /** Tiptap editor for the active tile. We attach pointer listeners to
   *  `editor.view.dom` and read its DOM bounding rects for positioning. */
  readonly editor: Editor;
  readonly resolvedThreadIds: ReadonlySet<string>;
  /** Triggered when the user clicks the popover so the parent can swap the
   *  sidebar to comments view + focus the matching thread. */
  readonly onActivateThread: (threadId: string) => void;
}

interface HoverState {
  readonly threadId: string;
  readonly anchor: HTMLElement;
}

/**
 * Lightweight 300 ms-delayed preview that surfaces a thread's quoted snapshot
 * + most recent comment when the user dwells on a `[data-thread-id]` span.
 *
 * Dwelling is a pointing-device gesture, so the preview is offered to a mouse
 * only. A touch pointer emits `pointerout` immediately after `pointerup`, which
 * cancels the pending show - a tap could never open the preview - and there is
 * no hover state to reach it from either. A tap therefore skips the preview
 * entirely and activates the thread directly, which is what the preview's own
 * click does.
 *
 * Implementation notes:
 *  - We attach pointerdown / pointerover / pointerout / click listeners to the
 *    editor's root DOM rather than walking React refs - the `threadAnchor` mark
 *    is rendered by ProseMirror, not React, so a delegated DOM listener is the
 *    canonical bridge. `click` carries no `pointerType`, so the preceding
 *    `pointerdown` records which device produced it; the "mouse" default means
 *    an event with no pointer behind it takes the desktop path.
 *  - The hover threadId is mirrored into the Zustand store so the
 *    decoration plugin paints the matching anchor at the same time the
 *    popover appears.
 *  - We pull the thread payload from the cached
 *    `epic.listCommentThreads` query - no extra RPC traffic. If the cache
 *    is empty (sidebar never opened) we render nothing rather than blocking
 *    on a fetch; the click fallback still works because the parent invokes
 *    the sidebar swap which lazily fetches.
 */
export function ThreadAnchorHoverPopover(props: ThreadAnchorHoverPopoverProps) {
  const {
    epicId,
    hostClient,
    artifactType,
    artifactId,
    editor,
    resolvedThreadIds,
    onActivateThread,
  } = props;

  const setHoverThread = useCommentThreadsStore((s) => s.setHoverThread);
  const [hover, setHover] = useState<HoverState | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const floatingRef = useRef<HTMLButtonElement | null>(null);
  // Which device produced the gesture in flight. `click` does not carry a
  // pointer type of its own, so it is read from the `pointerdown` that preceded
  // it.
  const lastPointerTypeRef = useRef<string>("mouse");
  // Render into the pane's portal host so a hover popover triggered inside a
  // background split pane is hidden with that pane, not shown over the partner.
  const paneContainer = usePanePortalContainer();

  // Read the cached thread snapshot without firing a fresh request - the
  // hover popover should never trigger network traffic.
  const threadsQuery = useEpicCommentThreadsForClient({
    client: hostClient,
    epicId,
    artifactType: artifactType,
    artifactId: artifactId,
    options: { enabled: false },
  });
  const threadsById = useMemo(() => {
    const map = new Map<string, CommentThreadWire>();
    if (threadsQuery.data === undefined) return map;
    for (const thread of threadsQuery.data.threads) {
      map.set(thread.threadId, thread);
    }
    return map;
  }, [threadsQuery.data]);

  const cancelTimers = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleShow = useCallback(
    (threadId: string, anchor: HTMLElement) => {
      cancelTimers();
      showTimerRef.current = window.setTimeout(() => {
        setHover({ threadId, anchor });
        setHoverThread(epicId, threadId);
      }, HOVER_DELAY_MS);
    },
    [cancelTimers, epicId, setHoverThread],
  );

  const scheduleHide = useCallback(() => {
    cancelTimers();
    hideTimerRef.current = window.setTimeout(() => {
      setHover(null);
      setHoverThread(epicId, null);
    }, 100);
  }, [cancelTimers, epicId, setHoverThread]);

  const handlePointerDown = useEffectEvent((event: PointerEvent) => {
    lastPointerTypeRef.current = event.pointerType;
  });

  const handlePointerOver = useEffectEvent((event: PointerEvent) => {
    if (!isHoverCapablePointer(event.pointerType)) return;
    const anchor = findThreadAnchor(event.target);
    if (anchor === null) return;
    const threadId = anchor.dataset.threadId ?? "";
    if (threadId.length === 0) return;
    if (resolvedThreadIds.has(threadId)) return;
    scheduleShow(threadId, anchor);
  });

  const handlePointerOut = useEffectEvent((event: PointerEvent) => {
    const from = findThreadAnchor(event.target);
    const to = findThreadAnchor(event.relatedTarget);
    if (from !== null && from === to) return;
    scheduleHide();
  });

  const handleClick = useEffectEvent((event: MouseEvent) => {
    if (isHoverCapablePointer(lastPointerTypeRef.current)) return;
    // A thread anchor may sit ON a link: the `threadAnchor` mark sets
    // `excludes: ""`, so it deliberately overlaps other marks, and the artifact
    // link layer listens for `click` on this same editor root. A tap inside a
    // link therefore has two possible readings, and it is resolved in favour of
    // the link - the only one of the two with no other way to reach it. Every
    // thread on the artifact is listed in the comments panel, while a link
    // inside a document body has no affordance but its own text. Resolving it
    // here, on the shape of the DOM, is also what keeps the answer from
    // depending on which surface happened to register its listener first.
    if (findLinkAnchor(event.target) !== null) return;
    const anchor = findThreadAnchor(event.target);
    if (anchor === null) return;
    const threadId = anchor.dataset.threadId ?? "";
    if (threadId.length === 0) return;
    if (resolvedThreadIds.has(threadId)) return;
    cancelTimers();
    setHover(null);
    setHoverThread(epicId, null);
    onActivateThread(threadId);
  });

  // Delegate pointer events on the editor root. ProseMirror reuses the same
  // `editor.view.dom` reference for the lifetime of the editor instance, so
  // attaching once is safe.
  useEffect(() => {
    const root = editor.view.dom;
    root.addEventListener("pointerdown", handlePointerDown);
    root.addEventListener("pointerover", handlePointerOver);
    root.addEventListener("pointerout", handlePointerOut);
    root.addEventListener("click", handleClick);
    return () => {
      root.removeEventListener("pointerdown", handlePointerDown);
      root.removeEventListener("pointerover", handlePointerOver);
      root.removeEventListener("pointerout", handlePointerOut);
      root.removeEventListener("click", handleClick);
      cancelTimers();
    };
  }, [editor, cancelTimers]);

  // Position the popover against the live anchor DOM node using Floating UI.
  useLayoutEffect(() => {
    const floating = floatingRef.current;
    if (floating === null || hover === null) return;
    const reposition = () => {
      void computePosition(hover.anchor, floating, {
        placement: "top-start",
        middleware: [offset(6), flip(), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        floating.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
      });
    };
    reposition();
    return autoUpdate(hover.anchor, floating, reposition);
    // `paneContainer` dep: rebind positioning to the live node after the portal
    // host settles (initially null → the pane container).
  }, [hover, paneContainer]);

  if (hover === null) return null;
  if (typeof document === "undefined") return null;

  const thread = threadsById.get(hover.threadId);
  if (thread === undefined) return null;

  const lastComment =
    thread.comments.length > 0
      ? thread.comments[thread.comments.length - 1]
      : null;
  const quotedText = thread.data.quotedText ?? "";

  return createPortal(
    <button
      ref={floatingRef}
      type="button"
      aria-label="Open thread"
      data-slot="thread-hover-popover"
      onPointerEnter={cancelTimers}
      onPointerLeave={scheduleHide}
      onClick={() => {
        cancelTimers();
        setHover(null);
        setHoverThread(epicId, null);
        onActivateThread(hover.threadId);
      }}
      className={cn(
        "absolute top-0 left-0 z-50 w-[min(90vw,22rem)] cursor-pointer rounded-md border border-border bg-popover p-3 text-left text-popover-foreground shadow-lg outline-none",
      )}
    >
      {quotedText.length > 0 ? (
        <p className="mb-2 line-clamp-2 border-l-2 border-muted-foreground/40 pl-2 text-ui-xs italic text-muted-foreground">
          {quotedText}
        </p>
      ) : null}
      {lastComment === null ? (
        <p className="text-ui-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <div className="flex items-start gap-2">
          <Avatar size="sm">
            <AvatarFallback>
              {deriveInitials(
                lastComment.author.fallbackHandle ?? lastComment.author.userId,
              )}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-ui-xs font-medium">
              {lastComment.author.fallbackHandle ?? lastComment.author.userId}
            </span>
            <CommentContent
              content={lastComment.content}
              className="line-clamp-3 text-ui-xs"
            />
          </div>
        </div>
      )}
      <p className="mt-2 text-overline uppercase text-muted-foreground">
        {thread.comments.length} comment
        {thread.comments.length === 1 ? "" : "s"} · click to open
      </p>
    </button>,
    paneContainer ?? document.body,
  );
}

/**
 * Whether this pointer can rest on a target without committing to it - the
 * precondition for a dwell-delayed preview. Only a mouse can: touch has no
 * hover state, and a pen reports one so briefly that the delay outlives it.
 * Everything else activates on the tap instead.
 */
function isHoverCapablePointer(pointerType: string): boolean {
  return pointerType === "mouse";
}

function findThreadAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>("[data-thread-id]");
}

/**
 * The link the artifact link layer would consider this event to be on. The
 * selector matches that layer's own, so the two surfaces cannot disagree about
 * what counts as a link and leave a tap claimed by both or by neither.
 */
function findLinkAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLAnchorElement>("a");
}
