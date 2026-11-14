import { create } from "zustand";

interface ContinueProfileRequest {
  readonly id: number;
  readonly hostId: string;
  readonly epicId: string;
  readonly agentId: string;
}

interface ContinueProfileState {
  readonly request: ContinueProfileRequest | null;
  readonly lastId: number;
}

const useContinueProfileStore = create<ContinueProfileState>(() => ({
  request: null,
  lastId: 0,
}));

/** Only the latest navigation gesture survives until its terminal tile takes it. */
export function armTerminalAgentContinueProfile(
  hostId: string,
  epicId: string,
  agentId: string,
): number {
  const id = useContinueProfileStore.getState().lastId + 1;
  useContinueProfileStore.setState({
    request: { id, hostId, epicId, agentId },
    lastId: id,
  });
  return id;
}

export function useTerminalAgentContinueProfile(
  hostId: string,
  epicId: string,
  agentId: string,
): ContinueProfileRequest | null {
  return useContinueProfileStore((state) => {
    const request = state.request;
    return request !== null &&
      request.hostId === hostId &&
      request.epicId === epicId &&
      request.agentId === agentId
      ? request
      : null;
  });
}

/** An older effect or a second view of the same agent cannot take a request twice. */
export function consumeTerminalAgentContinueProfile(id: number): boolean {
  if (useContinueProfileStore.getState().request?.id !== id) return false;
  useContinueProfileStore.setState({ request: null });
  return true;
}
