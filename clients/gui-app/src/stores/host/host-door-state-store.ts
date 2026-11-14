import { create } from "zustand";
import type { HostDoorState } from "@traycer-clients/shared/host-transport/host-door-state";
import { useAuthStore } from "@/stores/auth/auth-store";

interface HostDoorStateStore {
  readonly byHost: ReadonlyMap<string, HostDoorState>;
}

/** Why this app cannot use each host right now, one state per host. */
export const useHostDoorStateStore = create<HostDoorStateStore>(() => ({
  byHost: new Map(),
}));

let clearsOnSignOut = false;

/** Every state belongs to the signed-in person: a sign-out or a switch drops them all. */
function clearOnSignOut(): void {
  if (clearsOnSignOut) return;
  clearsOnSignOut = true;
  useAuthStore.subscribe((next, previous) => {
    if (
      next.contextMetadata?.userId !== previous.contextMetadata?.userId ||
      next.status === "signed-out" ||
      next.status === "signing-in"
    ) {
      if (useHostDoorStateStore.getState().byHost.size > 0)
        useHostDoorStateStore.setState({ byHost: new Map() });
    }
  });
}

export function noteHostDoorState(state: HostDoorState): void {
  clearOnSignOut();
  useHostDoorStateStore.setState((previous) => {
    const before = previous.byHost.get(state.hostId);
    if (
      before?.kind === state.kind &&
      before.detail?.code === state.detail?.code &&
      before.detail?.doorReason === state.detail?.doorReason
    )
      return previous;
    const byHost = new Map(previous.byHost);
    byHost.set(state.hostId, state);
    return { byHost };
  });
}

export function clearHostDoorState(hostId: string): void {
  useHostDoorStateStore.setState((previous) => {
    if (!previous.byHost.has(hostId)) return previous;
    const byHost = new Map(previous.byHost);
    byHost.delete(hostId);
    return { byHost };
  });
}

/** Clears `hostId`'s state only while it is `kind`. */
export function clearHostDoorStateOfKind(
  hostId: string,
  kind: HostDoorState["kind"],
): void {
  if (useHostDoorStateStore.getState().byHost.get(hostId)?.kind === kind)
    clearHostDoorState(hostId);
}

/** The state of one host outside React. */
export function hostDoorStateFor(hostId: string): HostDoorState | null {
  return useHostDoorStateStore.getState().byHost.get(hostId) ?? null;
}

/** The state of one host; `null` for no host or a host with none. */
export function useHostDoorState(hostId: string | null): HostDoorState | null {
  return useHostDoorStateStore((state) =>
    hostId === null ? null : (state.byHost.get(hostId) ?? null),
  );
}
