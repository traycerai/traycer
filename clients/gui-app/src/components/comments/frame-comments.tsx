import { useLayoutEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { MessageSquare, X } from "lucide-react";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import { useActivateCommentThread } from "@/hooks/comments/use-activate-comment-thread";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useActiveThreadId,
  useCommentThreadsStore,
} from "@/stores/comments/comment-threads-store";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useOrderedFrameThreads,
  type OrderedFrameThread,
} from "./use-ordered-frame-threads";
import { CommentThreadCard, FrameCommentSummary } from "./comment-thread-card";
import { useFrameCommentSurface } from "./frame-comment-surface-context";
import { usePaneFocused } from "@/components/epic-tabs/pane-visibility-context";

interface FrameCommentScope {
  readonly epicId: string;
  readonly artifactId: string;
  readonly artifactType: "canvas" | "html";
}

function anchorLabel(
  thread: CommentThreadWire,
  kind: "canvas" | "html",
): string {
  if (thread.data.anchorKind === "artifact")
    return kind === "canvas" ? "Whole canvas" : "Whole page";
  const label = thread.data.label ?? thread.data.quotedText ?? "Element";
  const element = /^(\S+) "([\s\S]*)"$/.exec(label);
  if (element !== null) return `${element[1]} · “${element[2]}”`;
  return thread.data.anchorKind === "text" ? `“${label}”` : label;
}

function closeThread(epicId: string, threadId: string): void {
  const store = useCommentThreadsStore.getState();
  if (store.activeByEpicId[epicId] === threadId)
    store.setActiveThread(epicId, null);
}

function FrameCommentThread(
  props: FrameCommentScope & { readonly entry: OrderedFrameThread },
) {
  const hostClient = useTabHostClient();
  const currentUserId = useAuthStore((state) => state.profile?.userId ?? null);
  const close = (): void =>
    closeThread(props.epicId, props.entry.thread.threadId);
  return (
    <CommentThreadCard
      epicId={props.epicId}
      artifactId={props.artifactId}
      artifactType={props.artifactType}
      hostClient={hostClient}
      currentUserId={currentUserId}
      canModerate={false}
      thread={props.entry.thread}
      hasAnchor={props.entry.hasAnchor}
      isExpanded
      onExpandedChange={(next) => {
        if (!next) close();
      }}
      onActivateAnchor={() => {}}
      framePresentation={{
        number: props.entry.number,
        label: anchorLabel(props.entry.thread, props.artifactType),
        onClose: close,
      }}
    />
  );
}

export function FrameCommentThreadPopover(
  props: FrameCommentScope & {
    readonly entry: OrderedFrameThread;
    readonly children: ReactNode;
  },
) {
  const active = useActiveThreadId(props.epicId);
  const surface = useFrameCommentSurface();
  const focused = usePaneFocused();
  const threadId = props.entry.thread.threadId;
  useLayoutEffect(() => {
    if (!focused) return;
    return surface.getState().registerPin(threadId);
  }, [surface, threadId, focused]);
  return (
    <Popover
      open={active === props.entry.thread.threadId}
      onOpenChange={(open) => {
        if (!open) closeThread(props.epicId, props.entry.thread.threadId);
      }}
    >
      <PopoverAnchor asChild>{props.children}</PopoverAnchor>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        layout="bare"
        aria-label={`Comment ${props.entry.number}`}
        className="touch-auto w-[min(90vw,24rem)] max-h-[min(70vh,var(--radix-popover-content-available-height))] overflow-y-auto"
        updatePositionStrategy="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="canvas-nopan canvas-nowheel contents">
          <FrameCommentThread {...props} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FrameCommentsToolbar(
  props: FrameCommentScope & { readonly viewTabId: string },
) {
  const entries = useOrderedFrameThreads(
    props.epicId,
    props.artifactId,
    props.artifactType,
  );
  const active = useActiveThreadId(props.epicId);
  const surface = useFrameCommentSurface();
  const hasRenderedPin = useStore(surface, (state) =>
    Array.from(state.pins.values()).includes(active ?? ""),
  );
  const activate = useActivateCommentThread(props);
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState<"open" | "resolved">("open");
  const toolbarThread = entries?.find(
    ({ thread }) => thread.threadId === active && !hasRenderedPin,
  );
  const count = entries?.filter(({ thread }) => !thread.resolved).length;
  const open = listOpen || toolbarThread !== undefined;
  const close = (): void => {
    setListOpen(false);
    if (toolbarThread !== undefined)
      closeThread(props.epicId, toolbarThread.thread.threadId);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={
            count === undefined ? "Comments" : `Comments (${count} open)`
          }
          aria-expanded={open}
          onClick={() => {
            if (toolbarThread !== undefined)
              closeThread(props.epicId, toolbarThread.thread.threadId);
            setListOpen(!listOpen);
          }}
        >
          <MessageSquare />
          {count ?? "—"}
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={12}
        layout="panel"
        aria-label={listOpen ? "All comments" : "Comment thread"}
        className="touch-auto w-[min(90vw,24rem)] max-h-[min(70vh,var(--radix-popover-content-available-height))]"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="canvas-nopan canvas-nowheel contents">
          {listOpen ? (
            <>
              <header className="flex items-center justify-between px-3 pt-3">
                <h2 className="text-ui-sm font-medium">All comments</h2>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Close comments"
                  onClick={close}
                >
                  <X />
                </Button>
              </header>
              <Tabs
                value={filter}
                onValueChange={(value) => {
                  if (value === "open" || value === "resolved")
                    setFilter(value);
                }}
                className="px-3 py-2"
              >
                <TabsList className="w-full">
                  <TabsTrigger value="open">Open</TabsTrigger>
                  <TabsTrigger value="resolved">Resolved</TabsTrigger>
                </TabsList>
              </Tabs>
              <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-3">
                {entries
                  ?.filter(
                    ({ thread }) => thread.resolved === (filter === "resolved"),
                  )
                  .map((entry) => (
                    <li key={entry.thread.threadId}>
                      <FrameCommentSummary
                        {...entry}
                        label={anchorLabel(entry.thread, props.artifactType)}
                        onActivate={() => {
                          setListOpen(false);
                          activate(entry.thread.threadId);
                        }}
                      />
                    </li>
                  ))}
                {entries === null ? (
                  <li className="py-4 text-ui-sm text-muted-foreground">
                    Comments couldn’t be loaded.
                  </li>
                ) : null}
                {entries?.every(
                  ({ thread }) => thread.resolved !== (filter === "resolved"),
                ) ? (
                  <li className="py-4 text-ui-sm text-muted-foreground">
                    No {filter} comments.
                  </li>
                ) : null}
              </ul>
            </>
          ) : null}
          {!listOpen && toolbarThread !== undefined ? (
            <div className="min-h-0 overflow-y-auto">
              <FrameCommentThread {...props} entry={toolbarThread} />
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
