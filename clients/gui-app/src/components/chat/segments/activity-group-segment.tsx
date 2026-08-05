import { Box, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { deriveActivityGroupCollapsibleKey } from "@/components/chat/chat-collapsible-key";
import {
  chatFindActivityGroupChildHeaderUnitId,
  chatFindActivityGroupSummaryUnitId,
} from "@/components/chat/chat-find";
import {
  activityChildLabel,
  hidesSoleReasoningHeader,
  type ActivityGroupModel,
  type ActivityGroupDetailSegment,
} from "@/components/chat/chat-activity-groups";
import { LiveActivityPromoteContext } from "./live-activity-promote-context";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/utils";
import {
  useActivityGroupEverHeaded,
  useActivityGroupOpen,
  useMarkActivityGroupHeaded,
  useSetActivityGroupOpen,
} from "@/stores/chats/activity-group-open-store-context";
import {
  useChatCollapsibleTileInstanceId,
  useChatFindForcedOpen,
  useSetChatFindForcedOpen,
} from "@/stores/chats/chat-find-force-store-context";
import { ResolvedApprovalSegment } from "./approval-segment";
import { CommandSegment } from "./command-segment";
import { FileChangeSegment } from "./file-change-segment";
import { LiveActivityWindow } from "./live-activity-window";
import { useLiveActivityWindowMounted } from "./live-activity-window-mount";
import { ReasoningSegment } from "./reasoning-segment";
import { LiveElapsed } from "./segment-elapsed";
import { SubagentSegment } from "./subagent-segment";
import { ToolSegment } from "./tool-segment";

interface ActivityGroupSegmentProps {
  readonly group: ActivityGroupModel;
}

export function ActivityGroupSegment(props: ActivityGroupSegmentProps) {
  const { group } = props;
  const tileInstanceId = useChatCollapsibleTileInstanceId();
  const collapsibleKey = useMemo(
    () => deriveActivityGroupCollapsibleKey(tileInstanceId, group.id),
    [group.id, tileInstanceId],
  );
  const userOpen = useActivityGroupOpen(group.id);
  const summaryFindUnitId = chatFindActivityGroupSummaryUnitId(group.id);
  const findForcedOpen = useChatFindForcedOpen(collapsibleKey);
  const open = userOpen || findForcedOpen;
  const setOpen = useSetActivityGroupOpen();
  const setFindForcedOpen = useSetChatFindForcedOpen();
  // The child a live-window click asked to see. Set at the moment of the click
  // and read once, by the copy of that child which mounts inside the expanded
  // body: it scrolls itself into view and, for reasoning, opens.
  const [revealSegmentId, setRevealSegmentId] = useState<string | null>(null);
  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(group.id, next);
      if (!next) {
        setFindForcedOpen(collapsibleKey, false);
        setRevealSegmentId(null);
      }
    },
    [collapsibleKey, group.id, setFindForcedOpen, setOpen],
  );
  const promoteChild = useCallback(
    (segmentId: string): void => {
      setRevealSegmentId(segmentId);
      setOpen(group.id, true);
    },
    [group.id, setOpen],
  );
  // Computed here rather than inline in the JSX: `jsx-no-leaked-render`
  // rewrites an inline `&&` into `? … : null`, which is right for children and
  // wrong for a boolean prop.
  const liveWindowShown = group.isActive && !open;
  // One reasoning block means the group header's thinking clause already IS
  // that block's label, so the block drops its own header rather than repeat
  // it a line lower. Shared with the find projection, which is why it stays a
  // pure function of the current shape: the projection is rebuilt from the
  // model and can see nothing else, so ANCHORS follow this and only this.
  const shapeHeaderless = hidesSoleReasoningHeader(group.segments);
  // ...but the visible header follows what this group has actually SHOWN,
  // because the shape flips both ways. A run loses a member when a command
  // backgrounds mid-turn, when a question tool's interview lands, and - before
  // the timeline builder even runs - when `buildAssistantSegments` suppresses a
  // subagent spawn tool. The group id comes from the first segment, so
  // `[reasoning, X] -> [reasoning]` happens under an unchanged id.
  //
  // Going headerless again there would strip a header the reader can see and,
  // since a headerless body always shows, unfold a completed trace nobody
  // opened. So the header latches - in the store, not in component state, and
  // recorded only when the children were on screen. See `headedIds`.
  //
  // Keyed by the SEGMENT, not the group. The group's id comes from its first
  // member, so removing that member renames the group: `[command, reasoning]`
  // whose command is promoted out becomes `[reasoning]` under a new id, and a
  // group-keyed latch is orphaned by the very move it is supposed to survive.
  // The earlier note here only reasoned about `[reasoning, X] -> [reasoning]`,
  // where reasoning is first and the id happens to hold still.
  const soleReasoningId = shapeHeaderless ? group.segments[0].id : null;
  const everHeaded = useActivityGroupEverHeaded(soleReasoningId);
  const soleReasoningHeaderless = shapeHeaderless && !everHeaded;
  // The children only EXIST in two containers: the bounded live window, and
  // `CollapsibleContent`, which unmounts its subtree when closed. A settled,
  // collapsed group renders neither - so a shrink that happens before anyone
  // opens it must leave the latch untouched, or the first open shows the label
  // twice for a header that was never on screen.
  //
  // `liveWindowMounted`, NOT `liveWindowShown`: `shown` is the target state and
  // the rows outlast it by the whole exit animation. When a group settles in the
  // same update that adds a second segment, `shown` goes false while the newly
  // headed reasoning row is on screen for another 300ms - and gating on `shown`
  // there records nothing, so a later shrink strips a header the reader saw.
  // That is the defect the latch exists to prevent, reintroduced through the
  // one gap where visible and shown disagree.
  const liveWindowMounted = useLiveActivityWindowMounted(liveWindowShown);
  const childrenShown = open || liveWindowMounted;
  // ...and a nested reasoning header only exists when there is reasoning to
  // head. Without this the set filled with command-only groups that never
  // rendered one, which is both meaningless and, when it was capped, actively
  // harmful: unrelated activity spent the budget that a real latch needed.
  //
  // EVERY reasoning segment is marked, not just one, because which of them ends
  // up alone is decided later: any other member can be the one that leaves, so
  // the survivor is not knowable at the time its header is on screen.
  const headedReasoningIds = useMemo(
    () =>
      shapeHeaderless
        ? []
        : group.segments
            .filter((segment) => segment.kind === "reasoning")
            .map((segment) => segment.id),
    [group.segments, shapeHeaderless],
  );
  const showsReasoningHeader = headedReasoningIds.length > 0;
  const markHeaded = useMarkActivityGroupHeaded();
  useEffect(() => {
    if (!showsReasoningHeader || !childrenShown) return;
    markHeaded(headedReasoningIds);
  }, [childrenShown, headedReasoningIds, markHeaded, showsReasoningHeader]);
  // The ONLY difference between the two containers is who caps the height. Both
  // render the same rows, with the same headers, the same labels and the same
  // collapse-on-completion - the window is a viewport onto the expanded body,
  // not a second rendering of it.
  //
  // `bodyBoundedByParent` is decided by the CONTAINER and never by the group's
  // shape, so it is constant for as long as a child is mounted and cannot flip
  // under a growing run.
  //
  // `headerlessReasoning` below IS shape-derived and CAN flip - that is the axis
  // #597 failed on, and it is admitted here deliberately, on two conditions.
  //
  // For a header the reader has SEEN it only ever goes true -> false, which is
  // the safe direction because it ADDS a header. Runs do NOT only grow, so that
  // is not free: `headedIds` on the open store is what holds a shown header in
  // place across a shrink, and its absence is what lets a group that arrived
  // already reduced stay unheaded.
  //
  // And the added header arrives CLOSED, taking the body with it - which is what
  // killed #597, and is right anyway. A headerless body shows because there is
  // nowhere else to put it, not because anyone opened it. Only `expanded`
  // records intent, and only `expanded` survives. See the `headerless` prop on
  // `ReasoningSegment` before changing either.
  const renderChildren = (bodyBoundedByParent: boolean): ReactNode =>
    group.segments.map((segment) => (
      <ActivityChildSegment
        key={segment.id}
        groupId={group.id}
        segment={segment}
        bodyBoundedByParent={bodyBoundedByParent}
        headerlessReasoning={soleReasoningHeaderless}
        // The ANCHOR follows the shape, the HEADER follows the latch. They
        // differ only in the latched state, and only one way round: a header
        // that renders without being a find target. The words are still indexed
        // once - on the group summary, which by definition says the same thing.
        // The dangerous direction, a unit with no anchor to paint, cannot occur.
        reasoningHeaderIndexed={!shapeHeaderless}
        // Only rows in the bounded window promote; inside the expanded body a
        // row has the height to open where it stands.
        promote={bodyBoundedByParent ? promoteChild : null}
        revealed={!bodyBoundedByParent && revealSegmentId === segment.id}
      />
    ));

  return (
    <Collapsible
      open={open}
      onOpenChange={updateOpen}
      className="text-ui-sm text-muted-foreground"
    >
      <CollapsibleTrigger
        data-find-include="true"
        data-chat-find-unit={summaryFindUnitId}
        aria-label={group.label}
        className={cn(
          "group/activity flex max-w-full items-center gap-2 overflow-hidden rounded-sm py-1 pr-1 text-left text-muted-foreground transition-colors",
          "hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <Box className="size-3.5 shrink-0 transition-colors" aria-hidden />
        {group.isActive ? (
          <Shimmer
            as="span"
            className={cn(
              "min-w-0 truncate font-medium",
              "[--shimmer-text-color:var(--color-muted-foreground)]",
              "group-hover/activity:[--shimmer-text-color:var(--color-foreground)]",
              "group-focus-visible/activity:[--shimmer-text-color:var(--color-foreground)]",
              "group-data-[state=open]/activity:[--shimmer-text-color:var(--color-foreground)]",
            )}
            duration={1.35}
            spread={1}
          >
            {group.label}
          </Shimmer>
        ) : (
          <span className="min-w-0 truncate transition-colors">
            {group.label}
          </span>
        )}
        {group.isActive && group.activeStartedAt !== null ? (
          <span data-find-skip className="contents">
            <LiveElapsed startedAt={group.activeStartedAt} />
          </span>
        ) : null}
        {/* Trailing, and revealed only on hover/focus/open. A leading caret
            beside the Box icon gave every collapsed run two glyphs before its
            first word, so the row read as decorated rather than as a title. */}
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 -translate-x-1 text-muted-foreground/65 opacity-0 transition-[opacity,transform,color]",
            "group-hover/activity:translate-x-0 group-hover/activity:text-foreground group-hover/activity:opacity-100",
            "group-focus-visible/activity:translate-x-0 group-focus-visible/activity:text-foreground group-focus-visible/activity:opacity-100",
            "group-data-[state=open]/activity:translate-x-0 group-data-[state=open]/activity:rotate-90 group-data-[state=open]/activity:text-foreground group-data-[state=open]/activity:opacity-100",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      {/* While the run is live and the group is collapsed, the rows show in a
          bounded window instead of being hidden entirely - you can watch the
          work without it growing the turn under the run indicator. Children are
          withheld once the group is open so they never exist in both this
          window and `CollapsibleContent` at once: a find unit rendered twice
          would double-count.

          The window caps the height, so a streaming reasoning child must not
          also render its own `ReasoningTail` - a second `overflow-y-auto`
          nested inside this one would fight it for the wheel.

          It also cannot expand in place: four line-heights clips a body to
          about one line and pushes the run out of view, so rows in here PROMOTE
          instead - the click opens this group with that row already unfolded. */}
      <LiveActivityWindow shown={liveWindowShown}>
        {open ? null : renderChildren(true)}
      </LiveActivityWindow>
      {/* No height cap and no tail pin here, so a streaming reasoning child
          keeps its own bounded `ReasoningTail`. */}
      <CollapsibleContent>
        <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-border/35 pl-3">
          {renderChildren(false)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ActivityChildSegmentProps {
  readonly groupId: string;
  readonly segment: ActivityGroupDetailSegment;
  /**
   * True inside the live window, false inside `CollapsibleContent` - a property
   * of the container, fixed for as long as the child is mounted in it. Only
   * reasoning honours it, and only to drop its own inner scroller; nothing
   * about how the row reads changes between the two.
   */
  readonly bodyBoundedByParent: boolean;
  /** The group holds exactly one reasoning block, which then renders unheaded. */
  readonly headerlessReasoning: boolean;
  /** The find projection emitted a unit for the reasoning child's header. */
  readonly reasoningHeaderIndexed: boolean;
  /**
   * Non-null inside the live window: opens the group and asks for this child
   * to be revealed, instead of expanding into four line-heights.
   */
  readonly promote: ((segmentId: string) => void) | null;
  /** This is the child a promote asked to see, now mounted in the open body. */
  readonly revealed: boolean;
}

function ActivityChildSegment(props: ActivityChildSegmentProps) {
  const { groupId, segment, bodyBoundedByParent, revealed } = props;
  const { headerlessReasoning, promote, reasoningHeaderIndexed } = props;
  const promoteSelf = useCallback((): void => {
    if (promote === null) return;
    promote(segment.id);
  }, [promote, segment.id]);
  // `nearest` is the point: a promote from a window that was already on screen
  // must not move the transcript at all. It only scrolls when the row landed
  // outside the viewport, which is what the extra rows of a newly-opened group
  // can do to the one that was clicked.
  //
  // Focus moves with it. The button that was clicked has just unmounted with
  // the window, so without this the caret lands back on `document.body` and a
  // keyboard user is returned to the top of the transcript having asked to be
  // taken somewhere.
  //
  // The target is the row's OWN trigger, marked explicitly. A bare
  // `querySelector("button")` takes the first button in document order, which
  // for a revealed reasoning block whose trace contains a fenced code block is
  // its "Copy code" button - focus lands on a control the reader never asked
  // for, inside the content rather than on the row. The wrapper is the fallback
  // for a block that renders no trigger at all (a finished headerless thought,
  // which has nothing left to disclose); it is labelled so the landing is
  // announced rather than being an anonymous div.
  const bindReveal = useCallback((node: HTMLDivElement | null): void => {
    if (node === null) return;
    const trigger = node.querySelector<HTMLElement>(
      "[data-activity-row-trigger]",
    );
    (trigger ?? node).focus({ preventScroll: true });
    node.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  const row = (
    <ActivityChildRow
      groupId={groupId}
      segment={segment}
      bodyBoundedByParent={bodyBoundedByParent}
      headerlessReasoning={headerlessReasoning}
      reasoningHeaderIndexed={reasoningHeaderIndexed}
      revealed={revealed}
    />
  );
  const wrapped =
    promote === null ? (
      row
    ) : (
      <LiveActivityPromoteContext.Provider value={promoteSelf}>
        {row}
      </LiveActivityPromoteContext.Provider>
    );
  if (!revealed) return wrapped;
  return (
    <div
      ref={bindReveal}
      tabIndex={-1}
      role="group"
      aria-label={activityChildLabel(segment)}
      className="rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {wrapped}
    </div>
  );
}

interface ActivityChildRowProps {
  readonly groupId: string;
  readonly segment: ActivityGroupDetailSegment;
  readonly bodyBoundedByParent: boolean;
  readonly headerlessReasoning: boolean;
  readonly reasoningHeaderIndexed: boolean;
  readonly revealed: boolean;
}

function ActivityChildRow(props: ActivityChildRowProps) {
  const { groupId, segment, bodyBoundedByParent, revealed } = props;
  const { headerlessReasoning, reasoningHeaderIndexed } = props;
  const headerFindUnitId = chatFindActivityGroupChildHeaderUnitId(
    groupId,
    segment.id,
  );
  switch (segment.kind) {
    case "tool":
      return (
        <ToolSegment
          id={segment.id}
          toolName={segment.toolName}
          inputSummary={segment.inputSummary}
          inputDetail={segment.inputDetail}
          error={segment.error}
          agentMessageSend={segment.agentMessageSend}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          stopped={segment.stopped}
          progress={segment.progress}
          backgroundOutput={segment.backgroundOutput}
          backgroundTask={segment.backgroundTask}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          variant="row"
          headerFindUnitId={
            segment.agentMessageSend === null ? headerFindUnitId : null
          }
        />
      );
    case "command":
      return (
        <CommandSegment
          command={segment.command}
          cwd={segment.cwd}
          exitCode={segment.exitCode}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          stopped={segment.stopped}
          progress={segment.progress}
          startedAt={segment.startedAt}
          variant="row"
          headerFindUnitId={headerFindUnitId}
          // Tool and subagent rows keep their open state in a store keyed by
          // segment id, so a promote survives the remount on its own. These
          // three hold it locally, and the copy that was clicked is gone - so
          // the promote has to be handed to the copy that replaces it, or the
          // click opens the group and nothing else.
          initiallyOpen={revealed}
        />
      );
    case "file_change":
      return (
        <FileChangeSegment
          segment={segment}
          variant="row"
          headerFindUnitId={headerFindUnitId}
          initiallyOpen={revealed}
        />
      );
    case "subagent":
      return (
        <SubagentSegment
          id={segment.id}
          name={segment.name}
          agentType={segment.agentType}
          task={segment.task}
          progressUpdates={segment.progressUpdates}
          result={segment.result}
          isStreaming={segment.isStreaming}
          endState={segment.endState}
          stopped={segment.stopped}
          startedAt={segment.startedAt}
          durationMs={segment.durationMs}
          workflowMeta={segment.workflowMeta}
          nested={segment.children}
          variant="row"
        />
      );
    case "reasoning":
      return (
        <ReasoningSegment
          findUnitId={reasoningHeaderIndexed ? headerFindUnitId : null}
          markdown={segment.markdown}
          isStreaming={segment.isStreaming}
          durationMs={segment.durationMs}
          bodyBoundedByParent={bodyBoundedByParent}
          headerless={headerlessReasoning}
          // Only a promoted block starts expanded - opening it is what the
          // click asked for. Headerless deliberately does NOT seed this: it
          // shows its body without it, and seeding would cost the streaming
          // preview its bound.
          initiallyExpanded={revealed}
        />
      );
    case "approval":
      if (segment.decision === null) return null;
      return (
        <ResolvedApprovalSegment
          toolName={segment.toolName}
          description={segment.description}
          inputSummary={segment.inputSummary}
          inputDetail={segment.inputDetail}
          decision={segment.decision}
          variant="row"
          headerFindUnitId={headerFindUnitId}
          initiallyOpen={revealed}
        />
      );
    default: {
      const _exhaustive: never = segment;
      void _exhaustive;
      return null;
    }
  }
}
