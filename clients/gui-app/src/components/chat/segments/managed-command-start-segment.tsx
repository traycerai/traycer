import type { ToolCallManagedCommandStarted } from "@traycer/protocol/persistence/epic/content-blocks";
import { LivePulse } from "@/components/ui/live-pulse";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ManagedCommandMonitorIcon } from "@/components/managed-commands/managed-command-monitor-icon";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { ManagedCommandTranscriptDoor } from "@/components/managed-commands/managed-command-transcript-door";
import {
  managedCommandStatusLabel,
  managedCommandTitle,
} from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useManagedCommandInEpic } from "@/stores/managed-commands/managed-commands-for-chat";
import {
  scopedChatOpenId,
  useChatOpenStoreScope,
} from "@/stores/chats/open-store-scope";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { LiveElapsed } from "./segment-elapsed";
import { SegmentCard } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";

/**
 * The `traycer_run_shell` call, rendered as the shell it started rather than as
 * a generic wrench row.
 *
 * A shell outlives the turn that created it, so this is the one segment in the
 * feed that keeps changing after its call finished: status is read LIVE off the
 * chat's own set, keyed by the id the host stamped on the block, so the single
 * card updates in place - Running, then Exited · code 0 - instead of the
 * transcript growing a second entry nobody asked for.
 *
 * Interaction is deliberately the provider command card's, not a new one:
 * chevron to a framed copyable command panel, elapsed counter and pulse while
 * live, no total once settled. Shells stop being the odd row out in a feed full
 * of command cards.
 */
export interface ManagedCommandStartSegmentProps {
  /** The tool_call block id, which scopes this card's open state. */
  readonly id: string;
  /** Identity stamped at the call; survives the live record's death. */
  readonly managedCommand: ToolCallManagedCommandStarted;
  /**
   * The command as the agent WROTE it, off the block's own `inputDetail`.
   *
   * Deliberately not the live record's `command`: a restart can re-spec a
   * shell, and this card is the record of one call - what that call asked for.
   * The output window is where the effective, current spec is reported.
   * `null` on a block whose input was never captured.
   */
  readonly command: string | null;
  readonly variant: "card" | "row";
  readonly headerFindUnitId: string | null;
}

export function ManagedCommandStartSegment(
  props: ManagedCommandStartSegmentProps,
) {
  const { managedCommand, command, variant } = props;
  const epicHandle = useMaybeOpenEpicHandle();
  const epicId = epicHandle?.epicId ?? null;
  const live = useManagedCommandInEpic(epicId ?? "", managedCommand.commandId);
  const openOutput = useManagedCommandDoor();
  const openScope = useChatOpenStoreScope();
  const open = useToolOpenStore((state) =>
    state.openIds.has(scopedChatOpenId(openScope, props.id)),
  );
  const setToolOpen = useToolOpenStore((state) => state.setOpen);

  // Inside a mounted chat transcript - which is what feeds the chat's own
  // command set - a shell missing from that set is one the host no longer has.
  // OUTSIDE an epic session there is nowhere to have looked, so absence proves
  // nothing and the card must not claim a deletion it cannot see.
  const gone = epicId !== null && live === null;
  const monitoring =
    live === null ? managedCommand.monitoring : live.monitoring;
  const description =
    live === null ? managedCommand.description : live.description;

  const header = (
    <>
      <ManagedCommandMonitorIcon
        monitoring={monitoring}
        decorative
        className="size-3.5"
      />
      {/* The directory this call started the shell in, frozen with the block
          the way the command is - the provider command card carries its cwd
          on the title exactly like this. Never the live record's `cwd`, which
          a later restart can move out from under a card that is the record of
          one call. Silent on blocks stamped before the payload carried it. */}
      <TooltipWrapper
        label={
          managedCommand.cwd === null ? null : (
            <span className="font-mono text-code-sm">
              cwd: {managedCommand.cwd}
            </span>
          )
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground/85">
          {managedCommandTitle({ description, monitoring })}
        </span>
      </TooltipWrapper>
      {/* A deleted shell keeps its name and drops its state: there is no status
          left to report, and "Exited" frozen from before the delete would be
          the card claiming to know something it does not. */}
      {live === null ? null : (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
            <ManagedCommandStatusDot
              status={live.status}
              className={undefined}
            />
            {managedCommandStatusLabel(live.status)}
          </span>
        </>
      )}
      {/* The live cluster, in the trailing position every other segment uses.
          Only while it runs: a settled shell shows no total, matching
          `CommandSegment`'s density call rather than inventing a duration this
          feed shows nowhere else. */}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {live !== null && live.status.state === "running" ? (
          <>
            <span data-find-skip className="contents">
              <LiveElapsed startedAt={live.status.startedAtMs} />
            </span>
            <LivePulse
              size="xs"
              tone="active"
              ariaLabel="Shell running"
              className={undefined}
            />
          </>
        ) : null}
      </span>
    </>
  );

  const headerAction = (
    <ManagedCommandTranscriptDoor
      commandId={managedCommand.commandId}
      gone={gone}
      onOpen={openOutput}
      testId={`managed-command-start-door-${managedCommand.commandId}`}
    />
  );

  // The command stays expandable forever, deleted or not: it is the record of
  // what this call asked for, and it is persisted with the block rather than
  // read off a shell that may no longer exist.
  const body =
    open && command !== null ? (
      <SegmentPanel
        label="Command"
        copyValue={command}
        tone="default"
        bodyChrome="framed"
        className={undefined}
      >
        <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-foreground/90">
          <span className="text-muted-foreground">$ </span>
          {command}
        </pre>
      </SegmentPanel>
    ) : null;

  const setOpen = (next: boolean): void =>
    setToolOpen(openScope, props.id, next);

  if (variant === "row") {
    return (
      <SegmentRow
        open={open}
        onOpenChange={setOpen}
        header={
          <>
            {header}
            {headerAction}
          </>
        }
        body={body}
        // Never destructive. A non-zero exit is routine for a shell the agent
        // started on purpose; the red dot beside the label is the whole of the
        // signal, per the demotion decision.
        tone="default"
        stickyHeader
        expandable={command !== null}
        headerFindUnitId={props.headerFindUnitId}
        bodyFindUnitId={null}
        className={undefined}
        footer={null}
      />
    );
  }
  return (
    <SegmentCard
      open={open}
      onOpenChange={setOpen}
      header={header}
      headerAction={headerAction}
      collapsedPreview={null}
      body={body}
      tone="default"
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable={command !== null}
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}
