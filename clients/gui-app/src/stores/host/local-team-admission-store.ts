import { create } from "zustand";
import type { LocalTeamAdmissionState } from "@traycer-clients/shared/host-transport/local-open-auth";
import { useAuthStore } from "@/stores/auth/auth-store";

interface AdmissionObservation {
  readonly userId: string;
  readonly state: LocalTeamAdmissionState;
}

interface LocalTeamAdmissionStore {
  readonly byHost: ReadonlyMap<string, AdmissionObservation>;
}

export const useLocalTeamAdmissionStore = create<LocalTeamAdmissionStore>(
  () => ({ byHost: new Map() }),
);

/** A connection's admission result, kept separate from fleet reachability. */
export function noteLocalTeamAdmission(
  hostId: string,
  userId: string,
  state: LocalTeamAdmissionState,
): void {
  if (useAuthStore.getState().contextMetadata?.userId !== userId) return;
  useLocalTeamAdmissionStore.setState((previous) => {
    const before = previous.byHost.get(hostId);
    if (before?.userId === userId && before.state === state) return previous;
    const byHost = new Map(previous.byHost);
    byHost.set(hostId, { userId, state });
    return { byHost };
  });
}

useAuthStore.subscribe((next, previous) => {
  if (
    next.contextMetadata?.userId !== previous.contextMetadata?.userId ||
    next.status === "signed-out" ||
    next.status === "signing-in"
  ) {
    if (useLocalTeamAdmissionStore.getState().byHost.size > 0) {
      useLocalTeamAdmissionStore.setState({ byHost: new Map() });
    }
  }
});

export function clearLocalTeamAdmission(hostId: string): void {
  useLocalTeamAdmissionStore.setState((previous) => {
    if (!previous.byHost.has(hostId)) return previous;
    const byHost = new Map(previous.byHost);
    byHost.delete(hostId);
    return { byHost };
  });
}
