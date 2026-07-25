import { Bot } from "lucide-react";
import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import {
  useEpicAgentRoleClaimsByAgentId,
  useEpicArtifactRecords,
  useEpicChatHarnessId,
  useMaybeEpicTuiAgentHarnessId,
  useOpenEpicId,
  type EpicTreeRecord,
} from "@/lib/epic-selectors";
import { cn } from "@/lib/utils";

type AgentTreeRecord = EpicTreeRecord & {
  readonly type: "chat" | "terminal-agent";
};

export function AgentReferenceChip(props: {
  readonly agentId: string;
  readonly display: "text" | "code";
}) {
  const records = useEpicArtifactRecords();
  const roleClaimsByAgentId = useEpicAgentRoleClaimsByAgentId();
  const epicId = useOpenEpicId();
  const resolution = resolveAgentReference({
    referenceId: props.agentId,
    records,
    roleClaimsByAgentId,
  });

  if (resolution === null) {
    return fallbackAgentId(props.agentId, props.display);
  }

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

type AgentReferenceCandidate =
  | {
      readonly kind: "agent";
      readonly agent: AgentTreeRecord;
      readonly referenceId: string;
    }
  | {
      readonly kind: "role";
      readonly agent: AgentTreeRecord;
      readonly referenceId: string;
      readonly roleClaim: RoleClaim;
    };

interface AgentReferenceResolution {
  readonly agent: AgentTreeRecord;
  readonly label: string;
  readonly roleClaim: RoleClaim | null;
}

function resolveAgentReference(args: {
  readonly referenceId: string;
  readonly records: ReadonlyArray<EpicTreeRecord>;
  readonly roleClaimsByAgentId: Readonly<Record<string, readonly RoleClaim[]>>;
}): AgentReferenceResolution | null {
  const agents = args.records.filter(
    (record): record is AgentTreeRecord =>
      record.type === "chat" || record.type === "terminal-agent",
  );
  const candidates: AgentReferenceCandidate[] = agents.flatMap((agent) => [
    { kind: "agent", agent, referenceId: agent.id },
    ...(Object.hasOwn(args.roleClaimsByAgentId, agent.id)
      ? args.roleClaimsByAgentId[agent.id].map(
          (roleClaim): AgentReferenceCandidate => ({
            kind: "role",
            agent,
            referenceId: roleClaim.claimId,
            roleClaim,
          }),
        )
      : []),
  ]);
  const normalizedReferenceId = args.referenceId.toLowerCase();
  const exact = candidates.filter(
    (candidate) =>
      candidate.referenceId.toLowerCase() === normalizedReferenceId,
  );
  const matches =
    exact.length > 0
      ? exact
      : candidates.filter((candidate) =>
          candidate.referenceId.toLowerCase().startsWith(normalizedReferenceId),
        );
  if (matches.length !== 1) return null;
  const match = matches[0];
  if (match.kind === "agent") {
    return { agent: match.agent, label: match.agent.name, roleClaim: null };
  }
  return {
    agent: match.agent,
    label: match.roleClaim.role,
    roleClaim: match.roleClaim,
  };
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
  const tileNavigation = useEpicTileNavigation();
  const chatHarnessId = useEpicChatHarnessId(props.agent.id);
  const tuiHarnessId = useMaybeEpicTuiAgentHarnessId(props.agent.id);
  const harnessId = chatHarnessId ?? tuiHarnessId;
  const openAgent = useCallback(() => {
    tileNavigation.openTileInEpic(props.epicId, {
      id: props.agent.id,
      instanceId: uuidv4(),
      type: props.agent.type,
      name: props.agent.name,
      hostId: props.agent.hostId,
    });
  }, [props.agent, props.epicId, tileNavigation]);

  return (
    <button
      type="button"
      onClick={openAgent}
      className={cn(
        "mx-[1px] inline-flex max-w-[min(26rem,80vw)] items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 align-baseline",
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

function fallbackAgentId(agentId: string, display: "text" | "code") {
  if (display === "code") return <code>{agentId}</code>;
  return <>{agentId}</>;
}
