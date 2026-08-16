import { RotateCw } from "lucide-react";
import type { ToolCallManagedCommandRestarted } from "@traycer/protocol/persistence/epic/content-blocks";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { ManagedCommandTranscriptDoor } from "@/components/managed-commands/managed-command-transcript-door";
import {
  managedCommandRestartDeltaPhrase,
  managedCommandRestartOutcomeLabel,
  managedCommandRestartTitle,
} from "@/lib/managed-commands/managed-command-copy";
import { useManagedCommandDoor } from "@/lib/managed-commands/use-managed-command-door";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useManagedCommandPresence } from "@/stores/managed-commands/managed-commands-for-chat";
import { useMaybeChatTranscript } from "@/components/chat/chat-transcript-context";
import {
  scopedChatOpenId,
  useChatOpenStoreScope,
} from "@/stores/chats/open-store-scope";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";
import { SegmentCard, SegmentCardHeaderActionCell } from "./segment-card";
import { SegmentPanel } from "./segment-panel";
import { SegmentRow } from "./segment-row";

/**
 * One successful `traycer_restart_shell`, rendered as the event it was.
 *
 * The start card is a shell's one LIVE card: it tracks the record and reads
 * status off the chat's own set. This card is the opposite kind of thing - an
 * immutable snapshot of one relaunch, at the call site where it happened. Three
 * restarts are three of these, in order, and together they are the shell's
 * spec history; nothing here re-reads the live record, because a card that
 * followed the present would turn every restart into the same claim about now.
 *
 * Everything shown comes off the payload the host stamped from the successful
 * tool RESULT: the effective command the shell relaunched under, the host's own
 * verdict on what changed (command, cwd, both, neither), and - only when the
 * relaunch did not come up - the status the result reported, frozen. The
 * directory itself is not shown - a host-disk detail the output window's
 * popover carries; the phrase is what matters here. Only the door is live - it asks whether the shell still exists, and
 * says so instead of opening a tab onto nothing.
 */
export interface ManagedCommandRestartSegmentProps {
  /** The tool_call block id, which scopes this card's open state. */
  readonly id: string;
  readonly restart: ToolCallManagedCommandRestarted;
  readonly variant: "card" | "row";
  readonly headerFindUnitId: string | null;
}

export function ManagedCommandRestartSegment(
  props: ManagedCommandRestartSegmentProps,
) {
  const { restart, variant } = props;
  const epicHandle = useMaybeOpenEpicHandle();
  const epicId = epicHandle?.epicId ?? null;
  const presence = useManagedCommandPresence({
    epicId,
    commandId: restart.commandId,
    owner: useMaybeChatTranscript(),
  });
  const openOutput = useManagedCommandDoor();
  const openScope = useChatOpenStoreScope();
  const open = useToolOpenStore((state) =>
    state.openIds.has(scopedChatOpenId(openScope, props.id)),
  );
  const setToolOpen = useToolOpenStore((state) => state.setOpen);

  // Same reading as the start card's: only the owning chat's open stream
  // saying the shell is not there counts as gone; a set that has not arrived
  // yet proves nothing.
  const gone = presence.kind === "absent";

  const header = (
    <>
      <RotateCw
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/80"
      />
      {/* No cwd on the card, same as the start card: the delta phrase says
          "cwd changed" when that is what this restart did, and the output
          window's details popover has the effective directory. */}
      <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground/85">
        {managedCommandRestartTitle(restart)}
      </span>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span
        className="shrink-0 text-ui-xs text-muted-foreground"
        data-testid={`managed-command-restart-delta-${restart.commandId}`}
      >
        {managedCommandRestartDeltaPhrase(restart)}
      </span>
      {/* The outcome the result reported, FROZEN - but only when it is news.
          A restart that came up running is the normal case and says nothing;
          worse, a frozen "● Running" reads as a live claim beside the start
          card's real one, and stays green after the shell is stopped. So the
          header stays quiet unless the relaunch did NOT come up: a spawn
          failure ("Failed to start"), or a command that had already exited by
          the time the tool returned. Never re-read from the live record. */}
      {restart.outcome.state === "running" ? null : (
        <>
          <span aria-hidden className="shrink-0 text-muted-foreground/40">
            ·
          </span>
          <span
            className="flex shrink-0 items-center gap-1.5 text-ui-xs text-muted-foreground"
            data-testid={`managed-command-restart-outcome-${restart.commandId}`}
          >
            <ManagedCommandStatusDot
              status={restart.outcome}
              className={undefined}
            />
            {managedCommandRestartOutcomeLabel(restart.outcome)}
          </span>
        </>
      )}
    </>
  );

  const headerAction = (
    <ManagedCommandTranscriptDoor
      commandId={restart.commandId}
      gone={gone}
      onOpen={openOutput}
      testId={`managed-command-restart-door-${restart.commandId}`}
    />
  );

  // The effective command, expandable forever: it is persisted with the block,
  // and it is what this relaunch actually ran, whatever the shell runs now.
  const body = open ? (
    <SegmentPanel
      label="Command"
      copyValue={restart.effectiveCommand}
      tone="default"
      bodyChrome="framed"
      className={undefined}
    >
      <pre className="m-0 px-3 py-2 font-mono text-code-sm whitespace-pre-wrap text-foreground/90">
        <span className="text-muted-foreground">$ </span>
        {restart.effectiveCommand}
      </pre>
    </SegmentPanel>
  ) : null;

  const setOpen = (next: boolean): void =>
    setToolOpen(openScope, props.id, next);

  if (variant === "row") {
    return (
      <SegmentRow
        // Sibling of the row's trigger, never inside it: the trigger is a
        // button, so a door nested in `header` was a button in a button - and
        // a click on the disabled one toggled the disclosure instead.
        headerAction={headerAction}
        open={open}
        onOpenChange={setOpen}
        header={header}
        body={body}
        // Never destructive, like the start card: a spawn failure is the red
        // dot beside the frozen outcome and nothing else.
        tone="default"
        stickyHeader
        expandable
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
      headerAction={
        <SegmentCardHeaderActionCell>
          {headerAction}
        </SegmentCardHeaderActionCell>
      }
      collapsedPreview={null}
      body={body}
      tone="default"
      headerPosition="normal"
      bodyOverflow="hidden"
      expandable
      headerFindUnitId={props.headerFindUnitId}
      bodyFindUnitId={null}
      className={undefined}
    />
  );
}
