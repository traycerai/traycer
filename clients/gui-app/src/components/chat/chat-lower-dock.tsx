import { useReadingWidthStyle } from "@/lib/layout-overrides";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import type {
  BackgroundItem,
  ChatActiveTurn,
  OpenChatQueuedItem,
  OpenChatQueuedPromptItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { PinnedTodoPanel } from "@/components/chat/chat-pinned-stack";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ActiveAgentsPanel } from "@/components/chat/chat-active-agents-panel";
import { BackgroundItemsPanel } from "@/components/chat/chat-background-items-panel";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";
import type { ChatDockSection } from "@/lib/chat/chat-dock-sections";
import type { AgentRow } from "@/hooks/agent/use-agent-stop-controls";
import { QueuedMessagePanel } from "@/components/chat/queued-message-surface";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import {
  useChatDockOpenStore,
  useChatQueueCollapsed,
} from "@/stores/chats/chat-dock-open-store";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";

import {
  ChatDockCompactStrip,
  ChatDockCompactStripProvider,
} from "@/components/chat/chat-dock-compact-strip";
import {
  ChatDockAttachedPanelSlot,
  ChatDockPillActionsHostProvider,
} from "@/components/chat/chat-dock-attached-panel";
import {
  useChatDockCompactStrip,
  type ChatDockCompactStripValue,
} from "@/components/chat/chat-dock-compact-context";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/region-drag";
import { LayoutClusterContextMenu } from "@/components/layout-editor/region-quick-verbs";
import { dockMemberMaterialised } from "@/components/chat/chat-dock-fold";
import { cn } from "@/lib/utils";
import type { ChatPinnedStackTopSpacing } from "@/components/chat/chat-pinned-stack";

/** One dock row's hotspot, registered by the tile regardless of which of the
 *  two anchors (the full row in the frame below, or the compact chip in the
 *  pill row above it) currently carries it. */
export interface DockRowHotspot {
  readonly hotspotRef: (node: HTMLElement | null) => void;
  /** The region's own Shown value - a hidden row draws neither row nor chip. */
  readonly shown: boolean;
  /** Whether this chat has live content for the row right now. */
  readonly hasContent: boolean;
  /** A hidden row materialising because the editor is pointing at it (L-14). */
  readonly ghost: boolean;
  /**
   * A layout session is live, so this row's own node has to BE a box.
   *
   * At rest the row wrapper is `display: contents` and the panel below it owns
   * the geometry; a `contents` box has no rect, so the hover outline and the
   * travelling ring would measure `0,0,0,0` (the same trap `drag-engine.ts`
   * refuses a `contents` clamp for, and C-06). This is more load-bearing under
   * L-87, not less: the sample workspace mounts these very rows, so the canvas
   * the editor opens is made of them.
   */
  readonly editing: boolean;
}

/**
 * The joined frame the full-size rows share (L-97).
 *
 * One frame tucked under the composer, not a stack of cards: `-mb-px` plus
 * `border-b-0` is what makes the dock and the input read as one surface, and
 * the panels inside it draw their own `border-t` separators.
 *
 * The fill is `bg-foreground/3`, not the `bg-muted/30` this frame used to
 * carry. gui-app's AGENTS.md bans a muted fill on a RAISED surface: every
 * preset's dark variant defines `--muted` identical to `--card`, so a bordered
 * box over `bg-canvas` painted with it is invisible in most of the eighteen
 * presets and only looks right in the default pair. An alpha of the foreground
 * is surface-independent by construction, and `/3` is the same tint
 * `composer-shell.tsx` paints the composer with - which is the whole point
 * here, since the frame's bottom edge IS the composer's top edge.
 *
 * `empty:hidden` because a chips-only chat keeps the dock alive (A.4.4) and a
 * bordered box with nothing in it is not a frame, it is a bug.
 */
const DOCK_FRAME_CLASS =
  "@container mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-border bg-foreground/3 empty:hidden";

export interface ChatLowerDockProps {
  readonly snapshotLoaded: boolean;
  readonly epicId: string;
  /** The chat this dock belongs to - the strip's managed-command join key. */
  readonly chatId: string;
  readonly viewTabId: string;
  readonly selfAgent: AgentRow | null;
  readonly activeAgents: ReadonlyArray<AgentRow>;
  readonly todo: PinnedTodoSnapshot | null;
  readonly restore: ChatRestoreContextValue;
  /**
   * The queue as this dock should render it. The caller may have removed the
   * received-A2A rows from it - see `folded` - so this is not always the
   * session's whole queue.
   */
  readonly queue: ChatSessionState["queue"];
  /**
   * Sections standing as a pill above the frame instead of as a row inside it.
   * Decided by the caller, which needs the same answer to size everything
   * below the dock.
   *
   * A pill-sized member is in here whether or not its panel is open (L-142):
   * an open pill's panel is the frame's TOPMOST, replaceable one, never a row
   * in dock order.
   */
  readonly folded: ReadonlySet<ChatDockSection>;
  /** The vertical order of the dock's members, Todo included. */
  readonly dockOrder: ReadonlyArray<ChatDockSection>;
  /** This tile's Customize hotspot for each dock member. */
  readonly hotspots: Readonly<Record<ChatDockSection, DockRowHotspot>>;
  readonly backgroundItems: ReadonlyArray<BackgroundItem> | undefined;
  /**
   * This chat's running managed commands, counted by the parent because the
   * surfaces around the dock size themselves from the same number - see
   * `chatBackgroundSectionVisible`.
   */
  readonly runningManagedCommandCount: number;
  /**
   * This chat's held shells, counted by the parent for the same reason - and
   * counted separately because the hold a human has to clear sits on a shell
   * that has FINISHED, which the running count above will never see. A chat
   * whose only background state is a hold opens the section on this alone.
   */
  readonly heldManagedCommandCount: number;
  /** This chat's port forwards, counted by the parent for the same reason. */
  readonly portForwardCount: number;
  readonly backgroundStopPendingTaskIds: ReadonlySet<string>;
  readonly backgroundStopAllPending: boolean;
  readonly backgroundSessionStopPending: boolean;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly canAct: boolean;
  readonly queueResumeRequested: boolean;
  readonly queueKeepPausedRequested: boolean;
  readonly readOnly: boolean;
  readonly editingQueueItemId: string | null;
  readonly topSpacing: ChatPinnedStackTopSpacing;
  readonly scrollRegionMaxHeightClass: string;
  readonly onQueuePause: () => string | null;
  readonly onQueueResume: () => string | null;
  readonly onQueueEdit: (item: OpenChatQueuedPromptItem) => void;
  readonly onQueueCancel: (item: OpenChatQueuedItem) => void;
  readonly onQueueAbortSteer: (item: OpenChatQueuedPromptItem) => void;
  readonly onQueueReorder: (
    item: OpenChatQueuedItem,
    beforeQueueItemId: string | null,
  ) => void;
  readonly onQueueSteerNow: (item: OpenChatQueuedPromptItem) => void;
  readonly onBackgroundItemClick: (item: BackgroundItem) => void;
  readonly onBackgroundItemStop: (taskId: string) => string | null;
  readonly onBackgroundItemsStopAll: () => string | null;
  readonly onBackgroundSessionStop: () => string | null;
}

interface DockRowPlan {
  readonly section: ChatDockSection;
  readonly hotspot: DockRowHotspot;
  readonly showRow: boolean;
}

/**
 * Whether a row draws as a FULL row inside the frame.
 *
 * Sample fill inside a real chat is gone with the in-place scene (L-87): the
 * sample workspace mounts these same panels against sample data (L-98), so
 * there is one code path and no stand-in leaves.
 */
function planDockRow(
  section: ChatDockSection,
  hotspot: DockRowHotspot,
  folded: ReadonlySet<ChatDockSection>,
): DockRowPlan {
  const unfolded =
    dockMemberMaterialised({ shown: hotspot.shown, ghost: hotspot.ghost }) &&
    !folded.has(section);
  return { section, hotspot, showRow: unfolded && hotspot.hasContent };
}

export function ChatLowerDock(props: ChatLowerDockProps) {
  // The pills are dock members too, now that they stand above the composer
  // rather than inside its workspace row: a fully compact chat has no row at
  // all and must still draw them (A.4.4).
  const strip = useChatDockCompactStrip();
  const readingWidth = useReadingWidthStyle();
  // The node an open pill's actions are portalled into. State rather than a
  // ref because the panels that fill it render in the same commit and must
  // re-render once it exists.
  const [pillActionsHost, setPillActionsHost] = useState<HTMLDivElement | null>(
    null,
  );
  // "This dock has drawn once over settled data", reported by the strip
  // because the strip is the one component that may compute it: the fact is
  // "has committed at least once", which no render can derive, and
  // `chat-dock-compact-strip.tsx` is where that is already reasoned about and
  // where the lint rule for it is already answered. One latch, two consumers -
  // the pills' arrival ring and the attached panel's grow (L-148, L-152).
  const [stripSettled, setStripSettled] = useState(false);
  const markStripSettled = useCallback(() => {
    setStripSettled(true);
  }, []);
  const rows = props.dockOrder.map((section) =>
    planDockRow(section, props.hotspots[section], props.folded),
  );
  const anyRowVisible = rows.some((row) => row.showRow);
  const anyChipVisible = strip !== null && strip.chips.length > 0;
  // The Message queue is not a dock member (G1-G2): never a pill, never hidden,
  // never reordered. Whenever it holds anything it is the frame's LAST child,
  // so it sits directly on the composer under every row and attached panel.
  const queueVisible = props.queue.items.length > 0;
  // The attached panel is built ONCE, here, and everything that claims a panel
  // is open follows THE NODE rather than the pill that asked for it.
  //
  // A pill exists on its member's content gate, and `dockPanelContent` can
  // still decline to draw the panel (Active agents without a self record), so
  // "the pill is there" and "the panel has something to draw" are different
  // questions and the pill must not answer the second. Deriving `openSection` from the node closes
  // that for every member at once: a pressed pill pointing at an
  // `aria-controls` id no element carries, and a separator drawn under
  // nothing, are both impossible by construction rather than by each
  // member remembering to keep two predicates equal.
  const openPill = strip === null ? null : strip.openSection;
  const attached =
    openPill === null
      ? null
      : dockPanel({
          section: openPill,
          attached: true,
          separated: false,
          editing: false,
          hotspotRef: null,
          dock: props,
        });
  const openSection = attached === null ? null : openPill;
  // ONE slot, kept mounted across a switch and keyed by nothing (L-152): the
  // pills are a switcher over a single box, so replacing what is inside it
  // must ease the box's height from one content's to the other's rather than
  // collapse and regrow. `AnimatePresence` is what lets it COLLAPSE on close
  // instead of vanishing; with the frame's `empty:hidden` that also means a
  // chips-only chat is back to no frame at all the moment the collapse ends.
  const attachedSlot =
    strip === null || openSection === null || attached === null ? null : (
      <ChatDockAttachedPanelSlot
        key="attached"
        section={openSection}
        panelId={strip.panelId}
        separated={anyRowVisible || queueVisible}
        settled={stripSettled}
      >
        {attached}
      </ChatDockAttachedPanelSlot>
    );
  // The strip below reads the corrected answer, so the open pill's
  // `aria-pressed`, its `aria-controls` and the panels' own
  // `useChatDockSectionAttached` all agree with what was drawn.
  const drawnStrip = useMemo<ChatDockCompactStripValue | null>(
    () => (strip === null ? null : { ...strip, openSection }),
    [strip, openSection],
  );

  if (!anyRowVisible && !anyChipVisible && !queueVisible) {
    return null;
  }

  const topPadding = props.topSpacing === "compact" ? "pt-2" : "pt-4";

  return (
    <ChatDockCompactStripProvider value={drawnStrip}>
      <ChatDockPillActionsHostProvider value={pillActionsHost}>
        <div className="pointer-events-none px-4" data-testid="chat-lower-dock">
          <div
            className={cn(
              // `gap-3`, not the `gap-1.5` this stack shipped with (L-153).
              // The pill row is a cluster of its own standing ABOVE the
              // composer's joined frame, and at 6px it read as part of the
              // frame's top edge - the owner saw the pills and the input
              // "stuck together". 12px is the step the composer's own stack
              // already keeps between its rows (`flex flex-col gap-3` in
              // `chat-composer.tsx`), so the pill row now reads as one more
              // band in that rhythm rather than as a lid on the frame. The
              // gap is between two flex children, so a chat with no frame
              // (`empty:hidden`) pays nothing for it and keeps the composer's
              // own `pt-4` as its separation.
              "pointer-events-auto mx-auto flex w-full flex-col gap-3 bg-canvas",
              readingWidth.className,
              topPadding,
            )}
            style={{ maxWidth: readingWidth.maxWidth }}
          >
            {/* One stack, two clusters (A.5, L-97): the pill row loose at the
              composer's left edge, then the joined frame tucked under the
              input. The pills sit ABOVE the frame rather than between it and
              the composer, because anything between the two would have to
              break the `-mb-px` tuck that makes dock and composer one surface.

              They stay separate `data-layout-cluster` containers because a
              drag between them would have to change the member's Size as a
              side effect of a move, which is not what L-68..L-71 describe - so
              `normalizeArrangement`'s cross-cluster refusal keeps meaning what
              it says. */}
            <ChatDockCompactStrip
              actionsRef={setPillActionsHost}
              snapshotLoaded={props.snapshotLoaded}
              onSettled={markStripSettled}
            />
            {/* The box the dock's rows are laid out in, which is what a canvas
              drag reorders inside (G3-01), under ONE quick-verb menu for the
              whole stack (L-144). A right-click anywhere on a row that does
              not belong to a control with a menu of its own - its header, its
              empty space - offers that member's verbs; the cluster resolves
              which member from the element under the pointer, exactly as the
              composer's toolbar clusters do, so five dock members cost one
              Radix root rather than five. */}
            <LayoutClusterContextMenu>
              <div
                {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}
                className={DOCK_FRAME_CLASS}
              >
                {/* The one pill-opened panel, topmost and replaceable (L-142):
                  clicking another pill puts a different section here, clicking
                  the open pill empties it. The fixed full rows follow, in dock
                  order, so the members the user chose to keep stay next to the
                  composer where they have always been.

                  The presence root is mounted unconditionally and only the
                  exit VALUE is gated on motion (L-152), the pattern the pill
                  strip beside it already keeps: `useMotionEnabled` includes
                  PANE VISIBILITY, so a conditional root here would reconcile
                  a different element every time the user switched tabs and
                  destroy the open panel's scroll position with it. */}
                <AnimatePresence initial={false}>
                  {attachedSlot}
                </AnimatePresence>
                {dockRows({
                  rows,
                  // `false`: the rule between the panel and the first row is
                  // the PANEL's own bottom border now (L-150), so it collapses
                  // with it instead of dropping a frame early. Rows still
                  // separate from each other.
                  separatedBefore: false,
                  dock: props,
                })}
                {/* Passive: it is chrome the editor cannot customize, so a
                    layout session dims it like the transcript, and the canvas
                    names it with a cue rather than a setting (C4). */}
                {queueVisible ? (
                  <div
                    data-layout-passive
                    data-layout-cue="Message queue · Always here"
                  >
                    <ChatDockQueuePanel
                      dock={props}
                      separated={anyRowVisible}
                    />
                  </div>
                ) : null}
              </div>
            </LayoutClusterContextMenu>
          </div>
        </div>
      </ChatDockPillActionsHostProvider>
    </ChatDockCompactStripProvider>
  );
}

/**
 * Plain functions, never JSX components (never invoked as `<X .../>`): each
 * dock row's hotspot ref is a plain callback threaded through here as data,
 * and the react-compiler's ref-safety check treats a same-named prop crossing
 * an actual COMPONENT boundary as a suspect ref access even though this one
 * is not - see the identical `dockHotspot`/`hotspotRef` shape that passes
 * clean one function up, inlined into `ChatLowerDock`'s own render instead of
 * split into child components. Calling these as ordinary functions (not JSX)
 * keeps everything in the one component the compiler already trusts.
 */
function dockRows(props: {
  readonly rows: ReadonlyArray<DockRowPlan>;
  readonly separatedBefore: boolean;
  readonly dock: ChatLowerDockProps;
}): ReactNode {
  let separated = props.separatedBefore;
  const nodes: ReactNode[] = [];
  for (const row of props.rows) {
    if (!row.showRow) continue;
    nodes.push(
      dockPanel({
        section: row.section,
        attached: false,
        separated,
        editing: row.hotspot.editing,
        hotspotRef: row.hotspot.hotspotRef,
        dock: props.dock,
      }),
    );
    separated = true;
  }
  return nodes;
}

/**
 * One dock member's panel, either as a fixed full row inside the frame or as
 * THE attached panel above them.
 *
 * The same component either way, and the presentation is read from the strip
 * context by the panel itself (`useChatDockSectionAttached`) rather than
 * passed down: a member is either a pill or a row, never both, so the two
 * readers of that one fact cannot disagree.
 */
function dockPanel(props: {
  readonly section: ChatDockSection;
  readonly attached: boolean;
  readonly separated: boolean;
  readonly editing: boolean;
  readonly hotspotRef: ((node: HTMLElement | null) => void) | null;
  readonly dock: ChatLowerDockProps;
}): ReactNode {
  const { dock } = props;
  const panel = dockPanelContent(props.section, props.separated, dock);
  if (panel === null) return null;
  // No wrapper of its own: the attached panel goes straight into the slot,
  // which already keys the crossfade by section and carries the region, the
  // handle and the height. A `contents` span in between would only be one
  // more box for a `popLayout` ghost to be measured through.
  if (props.attached) return panel;
  return (
    <span
      key={props.section}
      className={props.editing ? "block min-w-0" : "contents"}
      ref={props.hotspotRef}
    >
      {panel}
    </span>
  );
}

function dockPanelContent(
  section: ChatDockSection,
  separated: boolean,
  dock: ChatLowerDockProps,
): ReactNode {
  if (section === "filesChanged") {
    return (
      <ChatAccumulatedChangesPanel
        restore={dock.restore}
        separated={separated}
        scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      />
    );
  }
  if (section === "activeAgents") {
    if (dock.selfAgent === null) return null;
    return (
      <ActiveAgentsPanel
        epicId={dock.epicId}
        viewTabId={dock.viewTabId}
        self={dock.selfAgent}
        descendants={dock.activeAgents}
        scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
        separated={separated}
      />
    );
  }
  if (section === "todo") {
    if (!dock.snapshotLoaded || dock.todo === null) return null;
    return (
      <PinnedTodoPanel
        todo={dock.todo}
        scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
        separated={separated}
      />
    );
  }
  // An undefined `backgroundItems` is "the host has not said yet"; the
  // managed-command rows come from a different stream and need not wait on it.
  const items = dock.backgroundItems ?? [];
  return (
    <BackgroundItemsPanel
      items={items}
      epicId={dock.epicId}
      chatId={dock.chatId}
      viewTabId={dock.viewTabId}
      canAct={dock.canAct}
      readOnly={dock.readOnly}
      pendingStopTaskIds={dock.backgroundStopPendingTaskIds}
      stopAllPending={dock.backgroundStopAllPending}
      sessionStopPending={dock.backgroundSessionStopPending}
      turnActive={dock.activeTurnStatus !== null}
      scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      separated={separated}
      onItemClick={dock.onBackgroundItemClick}
      onStopItem={dock.onBackgroundItemStop}
      onStopAll={dock.onBackgroundItemsStopAll}
      onStopSession={dock.onBackgroundSessionStop}
    />
  );
}

/**
 * The Message queue, with its fold read from and written to the store per
 * (host, chat) (#2441): the panel unmounts every time the queue drains, and a
 * fold it kept itself came back open with the next queued message.
 *
 * A component of its own, mounted only while the queue holds something, so
 * the tab's host is read where a queue exists - always inside a tab - and not
 * by every dock (a layout-editor picture can draw one with no tab around it).
 */
function ChatDockQueuePanel(props: {
  readonly dock: ChatLowerDockProps;
  readonly separated: boolean;
}): ReactNode {
  const { dock } = props;
  const hostId = useTabHostId();
  const chatId = dock.chatId;
  const collapsed = useChatQueueCollapsed(hostId, chatId);
  const setQueueCollapsed = useChatDockOpenStore(
    (state) => state.setQueueCollapsed,
  );
  const onOpenChange = useCallback(
    (open: boolean) => {
      setQueueCollapsed(hostId, chatId, !open);
    },
    [hostId, chatId, setQueueCollapsed],
  );
  return (
    <QueuedMessagePanel
      queue={dock.queue}
      activeTurnStatus={dock.activeTurnStatus}
      canAct={dock.canAct}
      resumeRequested={dock.queueResumeRequested}
      keepPausedRequested={dock.queueKeepPausedRequested}
      readOnly={dock.readOnly}
      editingQueueItemId={dock.editingQueueItemId}
      scrollRegionMaxHeightClass={dock.scrollRegionMaxHeightClass}
      separated={props.separated}
      open={!collapsed}
      onOpenChange={onOpenChange}
      onPause={dock.onQueuePause}
      onResume={dock.onQueueResume}
      onEdit={dock.onQueueEdit}
      onCancel={dock.onQueueCancel}
      onAbortSteer={dock.onQueueAbortSteer}
      onReorder={dock.onQueueReorder}
      onSteerNow={dock.onQueueSteerNow}
    />
  );
}
