/**
 * A chat's shells, as a chip in the workspace-controls row under
 * the composer. The chat that started a command is where a human goes looking
 * for it, so this menu is the home for them - there is no epic-wide list any
 * more.
 *
 * It sits beside the host, workspace and context-usage chips because those are
 * the other per-chat facts a person checks between turns; a badge floating over
 * the transcript put it where the reading happens instead.
 *
 * The button exists only while the chat owns something. That makes its mere
 * presence the first piece of information: a chat with no shells says so by
 * showing nothing at all, rather than by offering an empty drawer.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { Radar } from "lucide-react";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { LiveElapsed } from "@/components/chat/segments/segment-elapsed";
import { ManagedCommandConnectionNotice } from "@/components/managed-commands/managed-command-connection-notice";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { ManagedCommandLifecycleActions } from "@/components/managed-commands/managed-command-lifecycle-actions";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { OwnerResourceChip } from "@/components/resources/resource-usage-chip";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
  getManagedCommandOutputDragId,
  getPaneScopedDndId,
  type EpicCanvasManagedCommandOutputDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  managedCommandStatusLabel,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";
import { useOpenManagedCommandOutput } from "@/lib/managed-commands/use-open-managed-command-output";
import { makeManagedCommandOutputTileRef } from "@/stores/epics/canvas/tile-schema/managed-command-output-tile";
import {
  unacknowledgedAttentionCommands,
  useManagedCommandAttentionStore,
} from "@/stores/managed-commands/managed-command-attention-store";
import {
  useManagedCommandsConnectionStatus,
  useManagedCommandsForChat,
} from "@/stores/managed-commands/managed-commands-for-chat";
import { useCompactRelativeTime } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

export interface ManagedCommandChatMenuProps {
  readonly epicId: string;
  readonly chatId: string;
  readonly hostId: string;
  /**
   * The canvas view this chat is rendered in, which a dragged-out row needs to
   * scope its dnd id and its drop. `null` outside a canvas view (the mobile
   * standalone chat), where dragging a row has nowhere to land - the row still
   * opens on click.
   */
  readonly viewTabId: string | null;
}

export function ManagedCommandChatMenu(props: ManagedCommandChatMenuProps) {
  const commands = useManagedCommandsForChat(
    props.epicId,
    props.chatId,
    props.hostId,
  );
  const connectionStatus = useManagedCommandsConnectionStatus(
    props.epicId,
    props.chatId,
    props.hostId,
  );
  const [open, setOpen] = useState(false);
  const [rowDragging, setRowDragging] = useState(false);
  const acknowledge = useManagedCommandAttentionStore(
    (state) => state.acknowledge,
  );
  const acknowledgedEndingById = useManagedCommandAttentionStore(
    (state) => state.acknowledgedEndingById,
  );
  const attentionCount = useMemo(
    () =>
      unacknowledgedAttentionCommands(commands, acknowledgedEndingById).length,
    [commands, acknowledgedEndingById],
  );
  const runningCount = commands.filter(
    (command) => command.status.state === "running",
  ).length;
  // dnd-kit reads a drag's payload live off the draggable that started it, so
  // unmounting the source row mid-gesture hands every later collision - and
  // the drop itself - an empty source. The menu therefore stays mounted for
  // the whole gesture and only steps out of the way visually; it closes once
  // the drag is over, dropped or abandoned.
  const rowDraggingChanged = useCallback((dragging: boolean) => {
    setRowDragging(dragging);
    if (!dragging) setOpen(false);
  }, []);

  // Seeing IS the acknowledgement: while the menu is open every outcome is
  // spelled out in the rows, so anything rendered - an ending that arrives
  // mid-look included - stops being badge news. Keyed on the commands, not
  // just the open transition, so the badge cannot go stale behind an open
  // menu and then nag about outcomes the user watched happen.
  useEffect(() => {
    if (open) acknowledge(commands);
  }, [open, commands, acknowledge]);

  // Deleting the last command while the menu is open would otherwise yank the
  // button - and the popover anchored to it - out from under the pointer that
  // just pressed Delete. The menu stays, says it is empty, and leaves on close.
  if (commands.length === 0 && !open) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TooltipWrapper
        label="Shells"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            // The badge renders bare numbers, so the accessible name says
            // what the number counts.
            aria-label={menuAccessibleName(attentionCount, runningCount)}
            data-testid="managed-command-chat-menu-trigger"
            data-attention={attentionCount > 0 ? "true" : "false"}
            className={cn(
              // The workspace chips' grammar: no plate or border of its own,
              // dimmed until hovered.
              "h-7 shrink-0 gap-1.5 px-1.5 text-ui-sm transition-[background-color,opacity] hover:bg-accent/50 focus-visible:opacity-100",
              attentionCount > 0
                ? // Attention is the one state that should not be dimmed.
                  "text-destructive hover:text-destructive"
                : "text-muted-foreground opacity-70 hover:opacity-100",
            )}
          >
            <Radar aria-hidden className="size-3.5" />
            <ManagedCommandMenuBadge
              attentionCount={attentionCount}
              runningCount={runningCount}
            />
          </Button>
        </PopoverTrigger>
      </TooltipWrapper>
      <PopoverContent
        align="end"
        // The trigger sits at the tile's bottom edge, so the list has room
        // above it and none below.
        side="top"
        // The delete confirmation is a modal dialog portaled outside this
        // Content's subtree; without this guard Radix reads its focus trap as
        // focus leaving the popover and dismisses it - unmounting the row and
        // the confirmation with it. Same guard, same reason, as the
        // notifications bell's nested filter menu. Escape still closes.
        onFocusOutside={(event) => event.preventDefault()}
        className={cn(
          // Capped to the viewport: a chat can accumulate many finished
          // shells, and rows past the fold must scroll, not vanish.
          "max-h-[min(60vh,26rem)] w-[min(90vw,24rem)] overflow-y-auto p-1",
          // Faded rather than closed - see `rowDraggingChanged`.
          rowDragging ? "opacity-40" : null,
        )}
      >
        {connectionStatus === "open" ? null : (
          <ManagedCommandConnectionNotice
            hasContent={commands.length > 0}
            testId="managed-command-chat-menu-disconnected"
            className={undefined}
          />
        )}
        <ManagedCommandMenuRows
          commands={commands}
          epicId={props.epicId}
          hostId={props.hostId}
          viewTabId={props.viewTabId}
          onRowDraggingChange={rowDraggingChanged}
        />
      </PopoverContent>
    </Popover>
  );
}

function menuAccessibleName(
  attentionCount: number,
  runningCount: number,
): string {
  if (attentionCount > 0) {
    return `Shells, ${attentionCount} need attention`;
  }
  if (runningCount > 0) {
    return `Shells, ${runningCount} running`;
  }
  return "Shells";
}

/**
 * Attention beats running: a shell that died is the thing to say even while
 * three others are healthy. With neither, the glyph carries no count at all -
 * "some exist, none of them need you" is best said by saying nothing.
 */
function ManagedCommandMenuBadge(props: {
  readonly attentionCount: number;
  readonly runningCount: number;
}) {
  if (props.attentionCount > 0) {
    return (
      <span aria-hidden data-testid="managed-command-chat-menu-attention">
        {props.attentionCount}
      </span>
    );
  }
  if (props.runningCount > 0) {
    return (
      <>
        <span
          aria-hidden
          className="inline-block size-1.5 shrink-0 rounded-full bg-success"
        />
        <span aria-hidden data-testid="managed-command-chat-menu-running">
          {props.runningCount}
        </span>
      </>
    );
  }
  return null;
}

function ManagedCommandMenuRows(props: {
  readonly commands: readonly ManagedCommand[];
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string | null;
  readonly onRowDraggingChange: (dragging: boolean) => void;
}) {
  if (props.commands.length === 0) {
    return (
      <p
        className="px-2 py-3 text-center text-ui-xs text-muted-foreground"
        data-testid="managed-command-chat-menu-empty"
      >
        No shells left
      </p>
    );
  }
  return (
    // `useManagedCommandsForChat` orders running-first, then most recent
    // activity, so the menu inherits its order rather than sorting again.
    <ul aria-label="Shells" className="space-y-0.5">
      {props.commands.map((command) => (
        <ManagedCommandMenuRow
          key={command.id}
          command={command}
          epicId={props.epicId}
          hostId={props.hostId}
          viewTabId={props.viewTabId}
          onDraggingChange={props.onRowDraggingChange}
        />
      ))}
    </ul>
  );
}

function ManagedCommandMenuRow(props: {
  readonly command: ManagedCommand;
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string | null;
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const { command, epicId, hostId, viewTabId } = props;
  const openOutput = useOpenManagedCommandOutput(epicId);
  const showResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const tile = useMemo(
    () => makeManagedCommandOutputTileRef({ commandId: command.id, hostId }),
    [command.id, hostId],
  );
  const dragData = useMemo<EpicCanvasManagedCommandOutputDragData | null>(
    () =>
      viewTabId === null
        ? null
        : {
            kind: MANAGED_COMMAND_OUTPUT_DND_TYPE,
            epicId,
            viewTabId,
            tile,
          },
    [epicId, viewTabId, tile],
  );
  // The same chat can be open in two tiles of one view (a supported canvas
  // state), so the command id alone would register duplicate draggables and
  // let a gesture bind to the other copy's node. The occurrence key keeps ids
  // unique per mounted row; the drop reads the payload, never the id.
  const occurrenceId = useId();
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id: getPaneScopedDndId(
      viewTabId ?? "",
      getManagedCommandOutputDragId(`${command.id}:${occurrenceId}`),
    ),
    data: dragData === null ? undefined : dragData,
    disabled: dragData === null,
  });

  // dnd-kit's 5px threshold means a plain click never reaches here, and it
  // flips `isDragging` back at drag end whether the drop landed or not - so
  // the cleanup is the menu's signal that the gesture is over.
  const { onDraggingChange } = props;
  useEffect(() => {
    if (!isDragging) return;
    onDraggingChange(true);
    return () => onDraggingChange(false);
  }, [isDragging, onDraggingChange]);

  return (
    <li
      className={cn(
        "group flex min-w-0 items-center gap-1 rounded-sm pr-1 hover:bg-muted/60",
        isDragging ? "opacity-50" : null,
      )}
    >
      {/*
       * The door is a button over the title alone, with the lifecycle controls
       * as siblings: a button flattens its subtree to presentational, so
       * nesting them would drop Stop/Start/Delete out of the accessibility
       * tree entirely.
       */}
      <button
        ref={setNodeRef}
        {...listeners}
        type="button"
        data-testid={`managed-command-menu-row-${command.id}`}
        onClick={() => {
          openOutput({ commandId: command.id, hostId });
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ManagedCommandMonitorIcon
          monitoring={command.monitoring}
          decorative
          className={undefined}
        />
        <ManagedCommandStatusDot
          status={command.status}
          className={undefined}
        />
        <span className="min-w-0 flex-1 truncate text-ui-xs text-foreground/85">
          {managedCommandTitle(command)}
        </span>
        <ManagedCommandMenuRowTiming command={command} />
      </button>
      {showResourceStats ? (
        <OwnerResourceChip
          epicId={epicId}
          kind="managed-command"
          ownerId={command.id}
          className={undefined}
        />
      ) : null}
      <span className="inline-flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <ManagedCommandLifecycleActions
          command={command}
          epicId={epicId}
          hostId={hostId}
          className={undefined}
        />
      </span>
    </li>
  );
}

/**
 * A running command is measured from when it started; a finished one is placed
 * by when it ended and labelled with how it ended, since "exited · code 1" is
 * the answer and "4m" alone is not.
 *
 * Its own leaf so the shared 60s clock repaints this label rather than the row.
 */
function ManagedCommandMenuRowTiming(props: {
  readonly command: ManagedCommand;
}) {
  const status = props.command.status;
  if (status.state === "running") {
    return <LiveElapsed startedAt={status.startedAtMs} />;
  }
  return (
    <span className="shrink-0 text-ui-xs text-muted-foreground">
      {managedCommandStatusLabel(status)}
      {" · "}
      <ManagedCommandMenuRowAge updatedAtMs={props.command.updatedAtMs} />
    </span>
  );
}

function ManagedCommandMenuRowAge(props: { readonly updatedAtMs: number }) {
  return <>{useCompactRelativeTime(props.updatedAtMs)}</>;
}
