import { create } from "zustand";
import type {
  SandboxMember,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

/**
 * A sandbox host known to be destroyed, before the task's end record says so:
 * its name, when, and why. Its relay session then ends as a revocation, which
 * is not a fault: the chat that ran there says how it ended, and nothing is
 * raised as needing attention.
 */
export interface EndedSandboxHost {
  readonly name: string;
  readonly at: number;
  /** The destroy's transition cause, as a row's `operation` reads it. */
  readonly cause: string;
  /** The member who destroyed it; `null` for a system cause. */
  readonly actor: SandboxMember | null;
  /** The sandbox's idle period; `null` when it has none of its own. */
  readonly idleMinutes: number | null;
}

interface EndedSandboxHostsState {
  readonly byHostId: Readonly<Partial<Record<string, EndedSandboxHost>>>;
}

export const useEndedSandboxHostsStore = create<EndedSandboxHostsState>(() => ({
  byHostId: {},
}));

/**
 * Records a destroy, and withdraws the stream faults its host raised before
 * the destroy was known here.
 */
export function recordEndedSandboxHost(
  hostId: string,
  ended: EndedSandboxHost,
): void {
  useEndedSandboxHostsStore.setState((state) => ({
    byHostId: { ...state.byHostId, [hostId]: ended },
  }));
  useAppLocalNotificationsStore.getState().removeHostStreamFailures(hostId);
}

/** A destroy that did not happen after all (refused or failed). */
export function forgetEndedSandboxHost(hostId: string): void {
  useEndedSandboxHostsStore.setState((state) => {
    if (state.byHostId[hostId] === undefined) return state;
    const byHostId = { ...state.byHostId };
    delete byHostId[hostId];
    return { byHostId };
  });
}

export function endedSandboxHost(hostId: string): EndedSandboxHost | null {
  return useEndedSandboxHostsStore.getState().byHostId[hostId] ?? null;
}

export function useEndedSandboxHost(
  hostId: string | null,
): EndedSandboxHost | null {
  return useEndedSandboxHostsStore((state) =>
    hostId === null ? null : (state.byHostId[hostId] ?? null),
  );
}

/**
 * Records every listed row being destroyed, from its `operation`: a destroy
 * started in another window, by another member or by the system is known
 * before its host's session ends.
 */
export function recordListedDestroys(
  sandboxes: readonly SandboxSummary[],
): void {
  for (const row of sandboxes) {
    const operation = row.operation;
    if (
      operation === null ||
      (operation.state !== "destroying" && operation.state !== "destroyed")
    ) {
      continue;
    }
    if (endedSandboxHost(row.hostId) !== null) continue;
    recordEndedSandboxHost(row.hostId, {
      name: row.displayName,
      at: operation.at,
      cause: operation.cause,
      actor: operation.actor,
      idleMinutes: row.idleMinutes,
    });
  }
}
