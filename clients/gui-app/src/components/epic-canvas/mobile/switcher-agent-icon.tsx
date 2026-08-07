import { Terminal } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import {
  useEpicActiveAgentIds,
  useEpicChatHarnessId,
  useMaybeEpicTuiAgentHarnessId,
} from "@/lib/epic-selectors";

/**
 * Agent-row icon for the switcher, reusing the desktop resolution pieces
 * without its tree rendering: a running spinner when the agent is active
 * (`useEpicActiveAgentIds`), else the harness brand (`HarnessIcon`) - GUI chats
 * from `useEpicChatHarnessId`, TUI agents from `useMaybeEpicTuiAgentHarnessId`
 * with a terminal badge chip to mark the surface - else the generic node
 * glyph. Every hook is called unconditionally; only chat/terminal-agent nodes
 * reach this component.
 */
export function SwitcherAgentIcon(props: {
  readonly nodeId: string;
  readonly type: "chat" | "terminal-agent";
}) {
  const { nodeId, type } = props;
  const isActive = useEpicActiveAgentIds().has(nodeId);
  const guiHarnessId = useEpicChatHarnessId(nodeId);
  const tuiHarnessId = useMaybeEpicTuiAgentHarnessId(nodeId);

  if (isActive) {
    return (
      <AgentSpinningDots
        className="size-4 text-muted-foreground"
        testId={`switcher-agent-active-${nodeId}`}
        variant="dots2"
      />
    );
  }

  if (type === "chat" && guiHarnessId !== null) {
    return <HarnessIcon harnessId={guiHarnessId} className="size-4" />;
  }

  if (type === "terminal-agent" && tuiHarnessId !== null) {
    return (
      <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
        <HarnessIcon harnessId={tuiHarnessId} className="size-4" />
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
          data-testid={`switcher-tui-badge-${nodeId}`}
        >
          <Terminal aria-hidden className="size-2.5" strokeWidth={2.5} />
        </span>
      </span>
    );
  }

  const FallbackIcon = EPIC_NODE_ICONS[type];
  return (
    <FallbackIcon
      aria-hidden
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}
