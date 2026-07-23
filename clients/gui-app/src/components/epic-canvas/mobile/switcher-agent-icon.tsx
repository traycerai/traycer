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
 * with a small terminal badge to mark the surface - else the generic node
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
        <Terminal
          aria-hidden
          className="pointer-events-none absolute -right-1 -bottom-1 size-2 text-muted-foreground"
          strokeWidth={3}
        />
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
