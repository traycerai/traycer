import { Bot } from "lucide-react";
import { useCallback, type MouseEvent } from "react";
import {
  resolveAgentReference,
  type AgentReferenceResolution,
  type AgentTreeRecord,
} from "@/components/chat/agent-reference-resolution";
import { TaskReferenceChip } from "@/components/chat/task-reference-chip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useEpicAgentOpenRef } from "@/hooks/epic/use-epic-agent-open-ref";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import {
  useEpicAgentRoleClaimsByAgentId,
  useEpicArtifactRecords,
  useEpicChatHarnessId,
  useMaybeEpicTuiAgentHarnessId,
  useOpenEpicId,
} from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";
import { onMiddleClick } from "@/lib/dom/on-middle-click";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";

interface AgentReferenceChipProps {
  readonly agentId: string;
  readonly display: "text" | "code";
}

/**
 * Markdown turns any id-shaped token into one of these. An agent or role
 * claim of the open epic it names wins; otherwise it is a task's chip or the
 * id as written ({@link TaskReferenceChip}), which is also all it can be with
 * no open epic behind it (a bot's channel, the layout editor's sample
 * transcript).
 */
export function AgentReferenceChip(props: AgentReferenceChipProps) {
  return (
    <EpicSessionGate fallback={notAnAgent(props)}>
      <ResolvedAgentReferenceChip {...props} />
    </EpicSessionGate>
  );
}

function ResolvedAgentReferenceChip(props: AgentReferenceChipProps) {
  const records = useEpicArtifactRecords();
  const roleClaimsByAgentId = useEpicAgentRoleClaimsByAgentId();
  const epicId = useOpenEpicId();
  const resolution = resolveAgentReference({
    referenceId: props.agentId,
    records,
    roleClaimsByAgentId,
  });

  if (resolution === null) return notAnAgent(props);

  return (
    <TooltipWrapper
      label={referenceTooltip(resolution)}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <AgentReferenceButton
        agent={resolution.agent}
        epicId={epicId}
        label={resolution.label}
        roleClaimId={resolution.roleClaim?.claimId ?? null}
      />
    </TooltipWrapper>
  );
}

function referenceTooltip(resolution: AgentReferenceResolution): string {
  if (resolution.roleClaim === null) {
    return `${resolution.agent.name}\n${resolution.agent.id}`;
  }
  return [
    `${resolution.roleClaim.role} role`,
    resolution.agent.name,
    resolution.roleClaim.scope,
    resolution.roleClaim.claimId,
  ].join("\n");
}

function AgentReferenceButton(props: {
  readonly agent: AgentTreeRecord;
  readonly epicId: string;
  readonly label: string;
  readonly roleClaimId: string | null;
}) {
  const { openTile } = useEpicTileNavigation();
  const chatHarnessId = useEpicChatHarnessId(props.agent.id);
  const tuiHarnessId = useMaybeEpicTuiAgentHarnessId(props.agent.id);
  const harnessId = chatHarnessId ?? tuiHarnessId;
  const buildOpenRef = useEpicAgentOpenRef({
    epicId: props.epicId,
    nodeId: props.agent.id,
    name: props.agent.name,
    type: props.agent.type,
  });
  const openAgent = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      openTile({
        node: buildOpenRef(),
        target: { epicId: props.epicId },
        // A chip is a button, like every other agent-opening control here.
        gesture: "explicit",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
    },
    [props.epicId, buildOpenRef, openTile],
  );

  return (
    <button
      type="button"
      onClick={openAgent}
      onAuxClick={onMiddleClick(openAgent)}
      className={cn(
        "mx-0.25 inline-flex max-w-[min(26rem,80vw)] items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 align-baseline",
        "text-ui-sm font-medium text-primary transition-colors hover:bg-primary/15 hover:text-primary focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
      data-agent-reference={props.agent.id}
      data-role-claim-reference={props.roleClaimId}
      // Excluded from quote selection: it's an interactive chip inside quotable
      // prose, so a drag across it must not append its label as quoted text.
      data-quote-exclude=""
    >
      {harnessId === null ? (
        <Bot className="size-3 shrink-0" aria-hidden />
      ) : (
        <HarnessIcon harnessId={harnessId} className="size-3 shrink-0" />
      )}
      <span className="truncate">{props.label}</span>
    </button>
  );
}

function notAnAgent(props: AgentReferenceChipProps) {
  // Without bots there are no task chips: an id that names no agent of the
  // open epic is the id as written, and nothing is read to title it.
  return UNRELEASED_FEATURES_ENABLED ? (
    <TaskReferenceChip referenceId={props.agentId} display={props.display} />
  ) : (
    fallbackAgentId(props.agentId, props.display)
  );
}

function fallbackAgentId(agentId: string, display: "text" | "code") {
  if (display === "code") return <code>{agentId}</code>;
  return <>{agentId}</>;
}
