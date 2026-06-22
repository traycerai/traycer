import { useMemo } from "react";
import {
  useDescendantIds,
  useEpicActiveAgentIds,
  useEpicArtifactRecords,
} from "@/lib/epic-selectors";

/** One row in an agent-stop surface (the current agent or a sub-agent). */
export interface AgentRow {
  readonly id: string;
  readonly title: string;
  readonly surface: "gui" | "tui";
  readonly active: boolean;
  /** The host this agent runs on - the stop action routes here. */
  readonly hostId: string;
}

export interface AgentStopControls {
  /**
   * The addressed agent itself - rendered as the panel's topmost row and
   * the "Stop all" anchor (Stop all = stop this agent + its subtree). Null
   * only if its record isn't in the projection (don't render the panel).
   */
  readonly self: AgentRow | null;
  /** The agent's actively-working descendants, each individually stoppable. */
  readonly descendants: ReadonlyArray<AgentRow>;
}

const EMPTY: ReadonlyArray<AgentRow> = Object.freeze([]);

function surfaceOf(type: string): "gui" | "tui" | null {
  if (type === "chat") return "gui";
  if (type === "terminal-agent") return "tui";
  return null;
}

/**
 * Drives the Active Agents panel (chat) and the TUI tile's sub-agents
 * dropdown with one shape, so both surfaces behave identically: the current
 * agent on top with Stop all, its active descendants beneath.
 *
 * Structure + titles come from the reactive epic tree (instant on spawn); the
 * live `active` bit comes from the cross-host awareness `agentWorking` set
 * (`useEpicActiveAgentIds`) - push-driven, no polling.
 */
export function useAgentStopControls(input: {
  readonly epicId: string;
  readonly rootAgentId: string;
}): AgentStopControls {
  const descendantIds = useDescendantIds(input.rootAgentId);
  const records = useEpicArtifactRecords();
  const activeIds = useEpicActiveAgentIds();

  return useMemo(() => {
    const recordById = new Map(records.map((record) => [record.id, record]));

    const selfRecord = recordById.get(input.rootAgentId);
    const selfSurface =
      selfRecord === undefined ? null : surfaceOf(selfRecord.type);
    const self: AgentRow | null =
      selfRecord === undefined || selfSurface === null
        ? null
        : {
            id: input.rootAgentId,
            title: selfRecord.name,
            surface: selfSurface,
            active: activeIds.has(input.rootAgentId),
            hostId: selfRecord.hostId,
          };

    if (activeIds.size === 0) return { self, descendants: EMPTY };

    const descendants: AgentRow[] = [];
    for (const id of descendantIds) {
      if (!activeIds.has(id)) continue;
      const record = recordById.get(id);
      if (record === undefined) continue;
      const surface = surfaceOf(record.type);
      if (surface === null) continue;
      descendants.push({
        id,
        title: record.name,
        surface,
        active: true,
        hostId: record.hostId,
      });
    }
    return {
      self,
      descendants: descendants.length === 0 ? EMPTY : descendants,
    };
  }, [descendantIds, records, activeIds, input.rootAgentId]);
}
