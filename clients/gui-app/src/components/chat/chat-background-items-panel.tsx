import { useId, useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  AlarmClock,
  Bot,
  ChevronDown,
  Monitor,
  Plug,
  Square,
  TerminalSquare,
  Workflow,
} from "lucide-react";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { LivePulse } from "@/components/ui/live-pulse";
import { LiveElapsed } from "@/components/chat/segments/segment-elapsed";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { ManagedCommandStopAction } from "@/components/managed-commands/managed-command-lifecycle-actions";
import {
  useManagedCommandStopAll,
  useManagedCommandStopAllIsPending,
} from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import { managedCommandTitle } from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import {
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
  getManagedCommandOutputDragId,
  getPaneScopedDndId,
  type EpicCanvasManagedCommandOutputDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import { useRunningManagedCommandsForChat } from "@/stores/managed-commands/managed-commands-for-chat";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { cn } from "@/lib/utils";
import {
  BASE_PAD_LEFT,
  INDENT_PX,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { TreeGroupGuide } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-guide";
import { buildTreeFromFlatRecords } from "@/lib/tree-utils";
import type { TreeNodeNested } from "@/lib/tree-types";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
interface RememberedBackgroundNode {
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly parentTaskId: string | null;
}

interface BackgroundTreeRecord {
  readonly taskId: string;
  readonly item: BackgroundItem | null;
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly parentTaskId: string | null;
  readonly order: number;
}

interface BackgroundTreeNode {
  readonly taskId: string;
  readonly item: BackgroundItem | null;
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly children: ReadonlyArray<BackgroundTreeNode>;
}

function backgroundKindLabel(kind: BackgroundItem["kind"]): string {
  switch (kind) {
    // A nested execution inside this turn, NOT a durable Agent in the Task.
    // Bare "Agent" collided with that; "Sub-agent" keeps the two apart.
    case "subagent":
      return "Sub-agent";
    case "command":
      return "Command";
    case "monitor":
      return "Monitor";
    case "wakeup":
      return "Wake";
    case "workflow":
      return "Workflow";
    case "mcp":
      return "MCP tool";
  }
  const unreachableKind: never = kind;
  return unreachableKind;
}

function backgroundStopLabel(kind: BackgroundItem["kind"]): string {
  if (kind === "wakeup") return "Cancel wake";
  return `Stop ${backgroundKindLabel(kind)}`;
}

function BackgroundKindIcon(props: { readonly kind: BackgroundItem["kind"] }) {
  switch (props.kind) {
    case "subagent":
      return <Bot aria-hidden className="size-3.5 shrink-0 text-primary/80" />;
    case "command":
      return (
        <TerminalSquare
          aria-hidden
          className="size-3.5 shrink-0 text-primary/80"
        />
      );
    case "monitor":
      return (
        <Monitor aria-hidden className="size-3.5 shrink-0 text-primary/80" />
      );
    case "wakeup":
      return (
        <AlarmClock aria-hidden className="size-3.5 shrink-0 text-primary/80" />
      );
    case "workflow":
      return (
        <Workflow aria-hidden className="size-3.5 shrink-0 text-primary/80" />
      );
    case "mcp":
      return <Plug aria-hidden className="size-3.5 shrink-0 text-primary/80" />;
  }
  const unreachableKind: never = props.kind;
  return unreachableKind;
}

function itemParentTaskId(item: BackgroundItem): string | null {
  return item.parentTaskId ?? null;
}

function itemScheduledFor(item: BackgroundItem): number | null {
  return item.kind === "wakeup" ? item.scheduledFor : null;
}

// The workflow row's aggregate story - current phase, the most recently
// active fleet-agent label, and finished/started counts - matching what the
// transcript's workflow card shows in its own live line (Flow 2). Any piece
// the host hasn't populated yet is omitted rather than shown as a placeholder.
function workflowRowSummary(
  item: Extract<BackgroundItem, { kind: "workflow" }>,
): string | null {
  const counts =
    item.agentsFinished !== null && item.agentsStarted !== null
      ? `${item.agentsFinished}/${item.agentsStarted} done`
      : null;
  const parts = [item.phase, item.activeLabel, counts].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

function rememberBackgroundItem(
  item: BackgroundItem,
): RememberedBackgroundNode {
  return {
    kind: item.kind,
    title: item.title,
    parentTaskId: itemParentTaskId(item),
  };
}

function rememberMissingParent(taskId: string): RememberedBackgroundNode {
  return {
    kind: "subagent",
    title: taskId,
    parentTaskId: null,
  };
}

function formatWakeupTime(scheduledFor: number): string {
  const date = new Date(scheduledFor);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function backgroundItemDisplayTitle(item: BackgroundItem): string {
  if (item.kind === "wakeup") {
    const scheduledFor = itemScheduledFor(item);
    const time =
      scheduledFor === null ? "scheduled time" : formatWakeupTime(scheduledFor);
    return `Waiting until ${time} · ${item.title}`;
  }
  if (item.kind === "workflow") {
    const summary = workflowRowSummary(item);
    return summary === null ? item.title : `${item.title} — ${summary}`;
  }
  if (item.kind === "mcp") {
    // The structured MCP identity beats the freeform title (which mirrors the
    // CLI's "server/tool" description and degrades with old hosts).
    return `${item.serverName} · ${item.toolName}`;
  }
  return item.title;
}

function BackgroundStopButton(props: {
  readonly label: string;
  readonly iconOnly: boolean;
  readonly disabled: boolean;
  readonly testId: string | undefined;
  readonly onClick: () => void;
}) {
  return (
    <TooltipWrapper
      label={props.iconOnly ? props.label : undefined}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0"
          disabled={props.disabled}
          aria-label={props.iconOnly ? props.label : undefined}
          data-testid={props.testId}
          onClick={(event) => {
            event.stopPropagation();
            props.onClick();
          }}
        >
          <Square aria-hidden className="size-3" />
          {props.iconOnly ? null : props.label}
        </Button>
      </span>
    </TooltipWrapper>
  );
}

// Collapse the host list to one row per task id. The host broadcasts a
// running-only list and removes an item atomically at its terminal, so this is
// a defensive guard: a transient duplicate (same `taskId`) must not render two
// rows with the same React key or two stop affordances for one task.
function dedupeByTaskId(
  items: ReadonlyArray<BackgroundItem>,
): ReadonlyArray<BackgroundItem> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.taskId)) return false;
    seen.add(item.taskId);
    return true;
  });
}

function parentChainContains(
  startTaskId: string,
  targetTaskId: string,
  recordByTaskId: ReadonlyMap<string, BackgroundTreeRecord>,
): boolean {
  let cursor: string | null = startTaskId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === targetTaskId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = recordByTaskId.get(cursor)?.parentTaskId ?? null;
  }
  return false;
}

function buildRememberedBackgroundNodes(
  items: ReadonlyArray<BackgroundItem>,
  previous: ReadonlyMap<string, RememberedBackgroundNode>,
): ReadonlyMap<string, RememberedBackgroundNode> {
  const next = new Map(
    items.map((item) => [item.taskId, rememberBackgroundItem(item)]),
  );
  const pendingParentIds: string[] = [];
  const queuedParentIds = new Set<string>();
  const enqueueParent = (taskId: string): void => {
    if (next.has(taskId) || queuedParentIds.has(taskId)) return;
    queuedParentIds.add(taskId);
    pendingParentIds.push(taskId);
  };
  items.forEach((item) => {
    const parentTaskId = itemParentTaskId(item);
    if (parentTaskId !== null) enqueueParent(parentTaskId);
  });
  let pendingIndex = 0;
  while (pendingIndex < pendingParentIds.length) {
    const taskId = pendingParentIds[pendingIndex];
    pendingIndex += 1;
    const remembered = previous.get(taskId) ?? rememberMissingParent(taskId);
    next.set(taskId, remembered);
    if (remembered.parentTaskId !== null) {
      enqueueParent(remembered.parentTaskId);
    }
  }
  return next;
}

function backgroundTreeNodeFromNested(
  node: TreeNodeNested<BackgroundTreeRecord>,
): BackgroundTreeNode {
  const data = node.data;
  return {
    taskId: data.taskId,
    item: data.item,
    kind: data.kind,
    title: data.title,
    children: Array.from(node.children ?? [])
      .sort(compareBackgroundTreeRecords)
      .map((child) => backgroundTreeNodeFromNested(child)),
  };
}

function compareBackgroundTreeRecords(
  left: TreeNodeNested<BackgroundTreeRecord>,
  right: TreeNodeNested<BackgroundTreeRecord>,
): number {
  return left.data.order - right.data.order;
}

function buildBackgroundTree(
  items: ReadonlyArray<BackgroundItem>,
  rememberedByTaskId: ReadonlyMap<string, RememberedBackgroundNode>,
): ReadonlyArray<BackgroundTreeNode> {
  const itemByTaskId = new Map(items.map((item) => [item.taskId, item]));
  const itemOrderByTaskId = new Map(
    items.map((item, index) => [item.taskId, index]),
  );
  const records = Array.from(rememberedByTaskId.entries()).map(
    ([taskId, remembered], index): BackgroundTreeRecord => {
      const item = itemByTaskId.get(taskId) ?? null;
      const order = itemOrderByTaskId.get(taskId) ?? items.length + index;
      if (item === null) {
        return {
          taskId,
          item,
          kind: remembered.kind,
          title: remembered.title,
          parentTaskId: remembered.parentTaskId,
          order,
        };
      }
      return {
        taskId,
        item,
        kind: item.kind,
        title: item.title,
        parentTaskId: itemParentTaskId(item),
        order,
      };
    },
  );
  const recordByTaskId = new Map(
    records.map((record) => [record.taskId, record]),
  );

  return buildTreeFromFlatRecords(records, {
    getId: (record) => record.taskId,
    getParentId: (record) => {
      const parentTaskId = record.parentTaskId;
      if (parentTaskId === null) return null;
      if (parentChainContains(parentTaskId, record.taskId, recordByTaskId)) {
        return null;
      }
      return parentTaskId;
    },
    getData: (record) => record,
  })
    .sort(compareBackgroundTreeRecords)
    .map((node) => backgroundTreeNodeFromNested(node));
}

function treeHasRunningTask(node: BackgroundTreeNode): boolean {
  if (node.item !== null && node.item.kind !== "wakeup") return true;
  return node.children.some((child) => treeHasRunningTask(child));
}

/**
 * What "Background" actually holds, counted the way the button beside it
 * behaves. Managed commands join the running total rather than standing apart:
 * "Stop all" now reaches them, so one summed count is a promise the panel can
 * keep, and the rows below say which is which.
 */
function backgroundHeaderSummary(input: {
  readonly runningCount: number;
  readonly waitingWakeCount: number;
}): string {
  const parts: string[] = [];
  if (input.runningCount > 0) {
    parts.push(`${input.runningCount} running`);
  }
  if (input.waitingWakeCount > 0) {
    parts.push(`${input.waitingWakeCount} waiting`);
  }
  return parts.length === 0 ? "0 running" : parts.join(" · ");
}

/**
 * A running shell as an ordinary row of this list, in the same grammar as a
 * harness background row beside it - glyph, title, live elapsed, hover stop.
 * To a human these are the same thing: work running behind the chat. The radar
 * / play glyphs are what keep a host-supervised shell apart from the harness's
 * own "Monitor" kind - more so now that a watching shell's title says Monitor
 * too, since no copy tells those two apart.
 *
 * The pill slot stays EMPTY on a shell row. A harness row spends it on a kind
 * because its rows differ in kind; a shell row's one distinguishing state -
 * the monitor flag - is carried by the title's own noun ("Monitor · deploy
 * watcher" vs "Shell · db migration"), so a pill saying it again would be a
 * second fact and is none. The noun and the glyph both swap live under a row
 * that stays put, which is how the flag flipping reads as news.
 *
 * Stop and nothing else. This is a "running right now" surface, so a row here
 * is a passing status rather than a durable object; deleting a shell - which
 * destroys its whole output history - belongs to the chat's Shells menu and
 * the output window, where the shell itself is the subject.
 *
 * The row drags out onto the canvas, on the same payload the Shells menu's
 * rows use, so the canvas needs to know nothing about where the gesture
 * started. Clicking still opens the window wherever the door puts it; dragging
 * is how a person says WHERE, and having to find the same shell in a second
 * menu to place it deliberately was the only reason to go there.
 */
function ManagedCommandRow(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
  readonly stoppable: boolean;
  readonly onOpen: ((commandId: string) => void) | null;
}) {
  const { command, epicId, hostId, viewTabId, onOpen } = props;
  const title = managedCommandTitle(command);
  const tile = useMemo(
    () => makeManagedCommandOutputTileRef({ commandId: command.id, hostId }),
    [command.id, hostId],
  );
  const dragData = useMemo<EpicCanvasManagedCommandOutputDragData>(
    () => ({
      kind: MANAGED_COMMAND_OUTPUT_DND_TYPE,
      epicId,
      viewTabId,
      tile,
    }),
    [epicId, viewTabId, tile],
  );
  // The same chat can be open in two tiles of one view, so the command id alone
  // would register duplicate draggables and let a gesture bind to the other
  // copy's node. The occurrence key keeps ids unique per mounted row; the drop
  // reads the payload, never the id.
  const occurrenceId = useId();
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: getPaneScopedDndId(
      viewTabId,
      getManagedCommandOutputDragId(`${command.id}:${occurrenceId}`),
    ),
    data: dragData,
    disabled: false,
  });

  return (
    <li className="m-0">
      <div
        className={cn(
          "group flex min-w-0 items-center gap-2 rounded-md pr-2 hover:bg-muted/40",
          isDragging ? "opacity-50" : null,
        )}
        style={{ paddingLeft: `${BASE_PAD_LEFT}px` }}
      >
        <TooltipWrapper
          label={title}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          <button
            ref={setNodeRef}
            {...listeners}
            type="button"
            data-testid={`managed-command-background-row-${command.id}`}
            disabled={onOpen === null}
            onClick={() => {
              onOpen?.(command.id);
            }}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isDragging ? "cursor-grabbing" : "cursor-grab",
            )}
          >
            <ManagedCommandMonitorIcon
              monitoring={command.monitoring}
              decorative
              className="size-3.5 text-primary/80"
            />
            <span className="block min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
              {title}
            </span>
            {command.status.state === "running" ? (
              <LiveElapsed startedAt={command.status.startedAtMs} />
            ) : null}
          </button>
        </TooltipWrapper>
        <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {props.stoppable ? (
            <ManagedCommandStopAction
              command={command}
              epicId={props.epicId}
              hostId={props.hostId}
              className={undefined}
            />
          ) : null}
        </span>
      </div>
    </li>
  );
}

function BackgroundTreeRows(props: {
  readonly nodes: ReadonlyArray<BackgroundTreeNode>;
  readonly depth: number;
  readonly stoppable: boolean;
  readonly pendingStopTaskIds: ReadonlySet<string>;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
}) {
  return (
    <>
      {props.nodes.map((node) => (
        <BackgroundTreeRow
          key={node.taskId}
          node={node}
          depth={props.depth}
          stoppable={props.stoppable}
          pendingStopTaskIds={props.pendingStopTaskIds}
          onItemClick={props.onItemClick}
          onStopItem={props.onStopItem}
        />
      ))}
    </>
  );
}

function BackgroundTreeRow(props: {
  readonly node: BackgroundTreeNode;
  readonly depth: number;
  readonly stoppable: boolean;
  readonly pendingStopTaskIds: ReadonlySet<string>;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
}) {
  const { node } = props;
  const item = node.item;
  const displayTitle =
    item === null ? node.title : backgroundItemDisplayTitle(item);

  return (
    <li className="m-0">
      <div
        className={cn(
          "group flex min-w-0 items-center gap-2 rounded-md pr-2 hover:bg-muted/40",
          item === null ? "text-muted-foreground" : null,
        )}
        style={{
          paddingLeft: `${props.depth * INDENT_PX + BASE_PAD_LEFT}px`,
        }}
      >
        {item === null ? (
          <TooltipWrapper
            label={displayTitle}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left">
              <BackgroundKindIcon kind={node.kind} />
              <span className="block min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
                {displayTitle}
              </span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
                {backgroundKindLabel(node.kind)}
              </span>
            </div>
          </TooltipWrapper>
        ) : (
          <>
            <TooltipWrapper
              label={displayTitle}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => props.onItemClick(item)}
              >
                <BackgroundKindIcon kind={item.kind} />
                <span className="block min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
                  {displayTitle}
                </span>
                {item.kind === "mcp" && item.startedAt !== null ? (
                  <LiveElapsed startedAt={item.startedAt} />
                ) : null}
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-ui-xs uppercase text-muted-foreground">
                  {backgroundKindLabel(item.kind)}
                </span>
              </button>
            </TooltipWrapper>
            <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <BackgroundStopButton
                label={backgroundStopLabel(item.kind)}
                iconOnly
                disabled={
                  !props.stoppable || props.pendingStopTaskIds.has(item.taskId)
                }
                testId={undefined}
                onClick={() => props.onStopItem(item.taskId)}
              />
            </span>
          </>
        )}
      </div>
      {node.children.length > 0 ? (
        <ul role="group" className="relative space-y-0.5">
          <TreeGroupGuide parentDepth={props.depth} />
          <BackgroundTreeRows
            nodes={node.children}
            depth={props.depth + 1}
            stoppable={props.stoppable}
            pendingStopTaskIds={props.pendingStopTaskIds}
            onItemClick={props.onItemClick}
            onStopItem={props.onStopItem}
          />
        </ul>
      ) : null}
    </li>
  );
}

export function BackgroundItemsPanel(props: {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly epicId: string;
  readonly chatId: string;
  /** The canvas view a dragged-out shell window lands in. */
  readonly viewTabId: string;
  readonly canAct: boolean;
  readonly readOnly: boolean;
  readonly pendingStopTaskIds: ReadonlySet<string>;
  readonly stopAllPending: boolean;
  readonly scrollRegionMaxHeightClass: string;
  readonly separated: boolean;
  readonly onItemClick: (item: BackgroundItem) => void;
  readonly onStopItem: (taskId: string) => string | null;
  readonly onStopAll: () => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [committedRememberedByTaskId, setCommittedRememberedByTaskId] =
    useState<ReadonlyMap<string, RememberedBackgroundNode>>(() => new Map());
  // A harness background item is stopped over the chat's own stream, so it
  // needs that stream open. A managed command is stopped by an RPC to its
  // host, which a reconnecting chat has no bearing on - gating it on `canAct`
  // too left a reconnecting chat with no way to stop a runaway shell.
  const stoppable = props.canAct && !props.readOnly;
  const managedStoppable = !props.readOnly;
  const items = useMemo(() => dedupeByTaskId(props.items), [props.items]);
  const rememberedByTaskId = useMemo(
    () => buildRememberedBackgroundNodes(items, committedRememberedByTaskId),
    [items, committedRememberedByTaskId],
  );
  // Adjust state during render (React-endorsed pattern for "remember the
  // latest derived value once inputs settle") instead of an effect: an
  // effect-based setState here would cascade an extra commit/paint on every
  // items change, whereas this conditional update resolves within the same
  // render pass before anything is painted.
  const [previousItemsForRemembering, setPreviousItemsForRemembering] =
    useState<typeof items | null>(null);
  if (items !== previousItemsForRemembering) {
    setPreviousItemsForRemembering(items);
    setCommittedRememberedByTaskId(rememberedByTaskId);
  }
  const tree = useMemo(
    () => buildBackgroundTree(items, rememberedByTaskId),
    [items, rememberedByTaskId],
  );
  const runningGroupCount = tree.filter(treeHasRunningTask).length;
  const waitingWakeCount = items.filter(
    (item) => item.kind === "wakeup",
  ).length;
  // Read from the same store the rows below read, so the header can never
  // claim a count the list does not show.
  const managedCommands = useRunningManagedCommandsForChat(
    props.epicId,
    props.chatId,
  );
  const headerSummary = backgroundHeaderSummary({
    runningCount: runningGroupCount + managedCommands.length,
    waitingWakeCount,
  });
  const hostId = useTabHostId();
  const openManagedCommand = useManagedCommandDoor();
  const stopAllManagedCommands = useManagedCommandStopAll(props.chatId);
  // Cross-instance: the same chat can be open in two tiles, and each panel
  // owns its own mutation observer - the shared read is what keeps the second
  // tile's button dead while the first tile's batch runs.
  const stopAllManagedPending = useManagedCommandStopAllIsPending(props.chatId);
  // "Stop all" means every row the panel is showing, and its two halves ride
  // different channels: the harness half needs the chat stream open, the
  // managed half is an RPC to the host that a reconnecting chat has no bearing
  // on. Each half is offered and sent on its own capability - gating the
  // button on the harness half alone left it dead during a reconnect, which is
  // exactly when a runaway shell most needs the one-click stop.
  const harnessStopAllReady = stoppable && !props.stopAllPending;
  const managedStopAllReady =
    managedStoppable && managedCommands.length > 0 && !stopAllManagedPending;
  // One button, one rule: live while there is something it can do, dead while
  // anything it started is still in flight. Re-enabling as soon as one half
  // finished let a second press resubmit the finished half mid-flight.
  const stopAllDisabled =
    (!harnessStopAllReady && !managedStopAllReady) ||
    props.stopAllPending ||
    stopAllManagedPending;
  const stopAll = () => {
    if (harnessStopAllReady) props.onStopAll();
    if (!managedStopAllReady) return;
    stopAllManagedCommands.mutate({
      hostId,
      epicId: props.epicId,
      commandIds: managedCommands.map((command) => command.id),
    });
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "bg-muted/30",
        props.separated ? "border-t border-border/50" : null,
      )}
      data-testid="background-items-panel"
    >
      <div className="flex items-stretch">
        <CollapsibleTrigger className="group/background flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <ChevronDown
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-muted-foreground/70 transition-transform",
              open ? null : "-rotate-90",
            )}
          />
          <LivePulse
            size="xs"
            tone="active"
            ariaLabel="Background activity"
            className={undefined}
          />
          <span className="shrink-0 text-ui-xs font-medium text-foreground/85">
            Background
          </span>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span
            data-testid="background-header-summary"
            className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground"
          >
            {headerSummary}
          </span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-1 pr-1.5">
          <BackgroundStopButton
            label="Stop all"
            iconOnly={false}
            disabled={stopAllDisabled}
            testId="background-stop-all"
            onClick={stopAll}
          />
        </div>
      </div>
      <CollapsibleContent>
        <div
          data-testid="background-items-list"
          data-native-scrollbar="true"
          className={cn(
            "overflow-y-auto border-t border-border/50",
            props.scrollRegionMaxHeightClass,
          )}
        >
          <ul className="m-0 flex list-none flex-col gap-0.5 p-1.5">
            {managedCommands.map((command) => (
              <ManagedCommandRow
                key={command.id}
                command={command}
                epicId={props.epicId}
                hostId={hostId}
                viewTabId={props.viewTabId}
                stoppable={managedStoppable}
                onOpen={openManagedCommand}
              />
            ))}
            <BackgroundTreeRows
              nodes={tree}
              depth={0}
              stoppable={stoppable}
              pendingStopTaskIds={props.pendingStopTaskIds}
              onItemClick={props.onItemClick}
              onStopItem={props.onStopItem}
            />
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
