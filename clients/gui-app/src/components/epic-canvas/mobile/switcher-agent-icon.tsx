import { Terminal } from "lucide-react";
import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";
import { TerminalAgentProgressIcon } from "@/components/chat/terminal-agent-progress-icon";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import {
  useEpicChatHarnessId,
  useEpicNodeHostId,
  useMaybeEpicTuiAgentHarnessId,
} from "@/lib/epic-selectors";

/** One prefix for both row kinds, so a switcher row's status test id reads the
 *  same whether it is a GUI chat or a TUI agent. */
const SWITCHER_AGENT_TEST_ID_PREFIX = "switcher-agent";

/**
 * So a switcher row answers the full vocabulary - failure, fork, interview and approval tones first, then the turn spinner, the muted background-activity glyph, unread-done, and the read-only lock - and updates live while the sheet is open.
 * That set is live, but it is a COARSER source than the desktop tree's: it cannot tell an active turn from an agent merely kept alive by background work, so both wore the busy spinner, and it carries no notification status at all, so a failed or waiting agent read as plain idle on the phone while the desktop row showed why.
 */
export function SwitcherAgentIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
  readonly type: "chat" | "terminal-agent";
}) {
  if (props.type === "terminal-agent") {
    return <SwitcherTuiAgentIcon epicId={props.epicId} nodeId={props.nodeId} />;
  }
  return <SwitcherChatIcon epicId={props.epicId} nodeId={props.nodeId} />;
}

function SwitcherChatIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
}) {
  const harnessId = useEpicChatHarnessId(props.nodeId);
  // Read the owner directly from the projection so legacy chats remain null instead of inheriting the session-host fallback used by openable tree records.
  const ownerHostId = useEpicNodeHostId(props.nodeId);
  return (
    <ChatProgressIcon
      epicId={props.epicId}
      chatId={props.nodeId}
      hostId={ownerHostId}
      className="size-4"
      mutedClassName="text-muted-foreground"
      testId={SWITCHER_AGENT_TEST_ID_PREFIX}
      // `undefined` lets `ChatProgressIcon` fall back to the plain chat glyph for a record whose harness cannot be resolved, matching the desktop row's idle slot.
      defaultIcon={
        harnessId === null ? undefined : (
          <HarnessIcon harnessId={harnessId} className="size-4" />
        )
      }
    />
  );
}

function SwitcherTuiAgentIcon(props: {
  readonly epicId: string;
  readonly nodeId: string;
}) {
  const harnessId = useMaybeEpicTuiAgentHarnessId(props.nodeId);
  const ownerHostId = useEpicNodeHostId(props.nodeId);
  const FallbackIcon = EPIC_NODE_ICONS["terminal-agent"];
  const idleIcon =
    harnessId === null ? (
      <FallbackIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    ) : (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <HarnessIcon harnessId={harnessId} className="size-4" />
        {/* A real <span> - independent of the mobile touch-slop `::after`, which only decorates the row Button. */}
        <span
          className="pointer-events-none absolute -right-1 -bottom-1 z-10 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-popover"
          data-testid={`switcher-tui-badge-${props.nodeId}`}
        >
          <Terminal aria-hidden className="size-2.5" strokeWidth={2.5} />
        </span>
      </span>
    );
  return (
    <TerminalAgentProgressIcon
      epicId={props.epicId}
      nodeId={props.nodeId}
      // The row's owner host, matching the sidebar row: agent ids are host-minted, so a same-id agent on another machine must not light this glyph.
      originHostId={ownerHostId}
      className="size-4"
      style={undefined}
      testIdPrefix={SWITCHER_AGENT_TEST_ID_PREFIX}
      idleIcon={idleIcon}
    />
  );
}
