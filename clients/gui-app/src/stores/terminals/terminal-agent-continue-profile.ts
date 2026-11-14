import { create } from "zustand";

interface ContinueProfileRequest {
  readonly id: number;
  readonly hostId: string;
  readonly epicId: string;
  readonly agentId: string;
}

interface ContinueProfileState {
  readonly requests: ReadonlyMap<string, ContinueProfileRequest>;
  readonly lastId: number;
}

const useContinueProfileStore = create<ContinueProfileState>(() => ({
  requests: new Map<string, ContinueProfileRequest>(),
  lastId: 0,
}));

function continueProfileTargetKey(
  hostId: string,
  epicId: string,
  agentId: string,
): string {
  return JSON.stringify([hostId, epicId, agentId]);
}

/** Each agent retains only its latest navigation gesture until its tile takes it. */
export function armTerminalAgentContinueProfile(
  hostId: string,
  epicId: string,
  agentId: string,
): number {
  const state = useContinueProfileStore.getState();
  const id = state.lastId + 1;
  const requests = new Map(state.requests);
  requests.set(continueProfileTargetKey(hostId, epicId, agentId), {
    id,
    hostId,
    epicId,
    agentId,
  });
  useContinueProfileStore.setState({
    requests,
    lastId: id,
  });
  return id;
}

export function useTerminalAgentContinueProfile(
  hostId: string,
  epicId: string,
  agentId: string,
): ContinueProfileRequest | null {
  const key = continueProfileTargetKey(hostId, epicId, agentId);
  return useContinueProfileStore((state) => state.requests.get(key) ?? null);
}

/** An older effect or a second view of the same agent cannot take a request twice. */
export function consumeTerminalAgentContinueProfile(id: number): boolean {
  const requests = useContinueProfileStore.getState().requests;
  for (const [key, request] of requests) {
    if (request.id !== id) continue;
    const remaining = new Map(requests);
    remaining.delete(key);
    useContinueProfileStore.setState({ requests: remaining });
    return true;
  }
  return false;
}
