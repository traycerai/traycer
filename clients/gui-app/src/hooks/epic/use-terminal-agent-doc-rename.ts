import { useMaybeEpicStore } from "@/hooks/use-epic-store";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { ownValue } from "@/lib/own-value";

export function terminalAgentUsesDocRename(
  state: OpenEpicState,
  id: string,
  hostId: string | null,
): boolean {
  const agent = ownValue(state.tuiAgents.byId, id);
  return agent === undefined || (agent.docResident && agent.hostId === hostId);
}

export function useTerminalAgentDocRename(
  id: string | null,
  hostId: string | null,
): boolean {
  return useMaybeEpicStore(
    (state) => id !== null && terminalAgentUsesDocRename(state, id, hostId),
    false,
  );
}
