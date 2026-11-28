import { useCallback, useSyncExternalStore } from "react";
import { useMaybeOpenEpicHandle } from "@/providers/use-open-epic-handle";
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
  const handle = useMaybeOpenEpicHandle();
  const store = id === null || handle === null ? null : handle.store;
  const subscribe = useCallback(
    (onChange: () => void) => store?.subscribe(onChange) ?? (() => undefined),
    [store],
  );
  const getSnapshot = useCallback(
    () =>
      id !== null &&
      store !== null &&
      terminalAgentUsesDocRename(store.getState(), id, hostId),
    [hostId, id, store],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
