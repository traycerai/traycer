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
 * Agent-row icon for the mobile switcher. Status resolution is the DESKTOP
 * mapping, not a mobile one: chats go through `ChatProgressIcon` and TUI agents
 * through the shared `TerminalAgentProgressIcon`, exactly as the sidebar chat
 * tree's rows do. So a switcher row answers the full vocabulary - failure,
 * fork, interview and approval tones first, then the turn spinner, the muted
 * background-activity glyph, unread-done, and the read-only lock - and updates
 * live while the sheet is open.
 *
 * It previously derived its own two-state mapping (`useEpicActiveAgentIds()`
 * membership -> spinner, else brand mark). That set is live, but it is a
 * COARSER source than the desktop tree's: it cannot tell an active turn from an
 * agent merely kept alive by background work, so both wore the busy spinner,
 * and it carries no notification status at all, so a failed or waiting agent
 * read as plain idle on the phone while the desktop row showed why.
 *
 * What stays mobile is only the IDLE glyph: the harness brand mark, with a
 * terminal badge chip on TUI rows to mark the surface. GUI chat rows keep the
 * brand mark here (the desktop tree deliberately does not, to avoid a column of
 * provider marks) because the switcher is the phone's only agent list and has
 * no hover card or header to surface the harness in.
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
  // The row's OWN owner host, off the chat projection - the same source the
  // desktop row reads. NOT the `hostId` on `useEpicArtifactRecords()`, which
  // stamps chat rows with the app-wide ACTIVE host (`recordForChat`'s
  // `fallbackHostId`; only TUI records carry a real owner). A retained epic tab
  // bound to host A while the user switches the active host to B would hand
  // this icon B, which misses the A-bound session handle and reads the
  // indicator response's `byOriginHostId[B]` - so the ladder, the access
  // snapshot, and the session's own run status all silently vanish while
  // epic awareness can still look live. `null` (a legacy chat with no
  // projected host) is a value `ChatProgressIcon` handles: no session to read,
  // and the indicator falls back to the surface aggregate.
  const ownerHostId = useEpicNodeHostId(props.nodeId);
  return (
    <ChatProgressIcon
      epicId={props.epicId}
      chatId={props.nodeId}
      hostId={ownerHostId}
      className="size-4"
      mutedClassName="text-muted-foreground"
      testId={SWITCHER_AGENT_TEST_ID_PREFIX}
      // `undefined` lets `ChatProgressIcon` fall back to the plain chat glyph
      // for a record whose harness cannot be resolved, matching the desktop
      // row's idle slot.
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
        {/* TUI-surface marker as a corner badge chip - a solid accent disc with
            a ring cutout (the repo's AvatarBadge / AccentDot-corner idiom;
            ring-popover to match this sheet's sibling artifact status dot)
            carrying the terminal glyph. The bare 8px muted glyph it replaces
            vanished at arm's length; the disc + contrast make a Claude TUI agent
            read distinctly from a Claude GUI chat against both the harness logo
            and the dark row. A real <span> - independent of the mobile
            touch-slop `::after`, which only decorates the row Button. */}
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
      // The row's owner host, matching the sidebar row: agent ids are
      // host-minted, so a same-id agent on another machine must not light
      // this glyph.
      originHostId={ownerHostId}
      className="size-4"
      style={undefined}
      testIdPrefix={SWITCHER_AGENT_TEST_ID_PREFIX}
      idleIcon={idleIcon}
    />
  );
}
