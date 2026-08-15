import { RotateCw } from "lucide-react";
import type { ToolCallManagedCommandRestarted } from "@traycer/protocol/persistence/epic/content-blocks";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ManagedCommandStatusDot } from "@/components/managed-commands/managed-command-status-dot";
import { ManagedCommandTranscriptDoor } from "@/components/managed-commands/managed-command-transcript-door";
import {
  managedCommandRestartDeltaPhrase,
  managedCommandRestartTitle,
  managedCommandStatusLabel,
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
import { SegmentCard } from "./segment-card";
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
 * tool RESULT: the effective command and directory the shell relaunched under,
 * the host's own verdict on what changed, and the status the result reported,
 * frozen. Only the door is live - it asks whether the shell still exists, and
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
      {/* The directory rides the title as a tooltip, the way the provider
          command card carries its cwd - and it is spelled out in the body,
          because for a cwd-only restart it is the whole change. */}
      <TooltipWrapper
        label={
          <span className="font-mono text-code-sm">
            cwd: {restart.effectiveCwd}
          </span>
        }
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground/85">
          {managedCommandRestartTitle(restart)}
        </span>
      </TooltipWrapper>
      <span aria-hidden className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      <span
        className="shrink-0 text-ui-xs text-muted-foreground"
        data-testid={`managed-command-restart-delta-${restart.commandId}`}
      >
        {managedCommandRestartDeltaPhrase(restart)}
      </span>
      {/* The outcome the result reported, in the shared status vocabulary and
          FROZEN there: no pulse, no elapsed, no re-read - what this restart
          ended in, not what the shell is doing now. Kept after deletion too,
          for the same reason: it is history, not a claim about the present. */}
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
        {managedCommandStatusLabel(restart.outcome)}
      </span>
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

  // The effective spec, expandable forever: it is persisted with the block, and
  // it is what this relaunch actually ran, whatever the shell runs now.
  const body = open ? (
    <div className="flex flex-col gap-2">
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
      <p
        className="px-1 text-ui-xs text-muted-foreground"
        data-testid={`managed-command-restart-cwd-${restart.commandId}`}
      >
        in{" "}
        <span className="font-mono text-code-sm text-foreground/85 wrap-anywhere">
          {restart.effectiveCwd}
        </span>
      </p>
    </div>
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
      headerAction={headerAction}
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
