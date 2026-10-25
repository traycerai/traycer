import type { RoleClaim } from "@traycer/protocol/persistence/epic/role-claims";
import type { EpicTreeRecord } from "@/lib/epic-selectors";

export type AgentTreeRecord = EpicTreeRecord & {
  readonly type: "chat" | "terminal-agent";
};

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

export interface AgentReferenceResolution {
  readonly agent: AgentTreeRecord;
  readonly label: string;
  readonly roleClaim: RoleClaim | null;
}

/**
 * What an id-shaped reference in markdown names: the one agent or role claim
 * whose id it is, or whose id it uniquely prefixes. Shared by the chip that
 * shows it and by read-aloud, which speaks the same label.
 */
export function resolveAgentReference(args: {
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
