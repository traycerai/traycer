import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface EpicTerminalLifetimeCloseAuthority {
  readonly hostId: string;
  readonly terminalId: string;
  readonly capability: "unknown" | "legacy" | "capable";
  readonly canMutate: boolean;
  readonly close: () => Promise<void>;
}

export interface EpicTerminalCloseAuthority extends EpicTerminalLifetimeCloseAuthority {
  readonly instanceId: string;
}

export interface EpicTerminalCloseRequest {
  readonly localInstanceIds: readonly string[];
  readonly retainedInstanceIds: readonly string[];
}

const authorityByInstanceId = new Map<string, EpicTerminalCloseAuthority>();
const pendingByLifetimeKey = new Map<string, Promise<void>>();

function lifetimeKey(hostId: string, terminalId: string): string {
  return `${hostId}\u0000${terminalId}`;
}

/**
 * The one semantic close boundary for every epic terminal surface. Calls for
 * the same lifetime share the exact in-flight promise even if the initiating
 * component unmounts; either settlement releases the key so failure can retry.
 */
export function requestEpicTerminalLifetimeClose(
  authority: EpicTerminalLifetimeCloseAuthority,
): Promise<void> | null {
  if (authority.capability !== "capable" || !authority.canMutate) {
    return null;
  }
  const key = lifetimeKey(authority.hostId, authority.terminalId);
  const existing = pendingByLifetimeKey.get(key);
  if (existing !== undefined) return existing;

  const pending = Promise.resolve().then(authority.close);
  pendingByLifetimeKey.set(key, pending);
  const release = (): void => {
    if (pendingByLifetimeKey.get(key) === pending) {
      pendingByLifetimeKey.delete(key);
    }
  };
  void pending.then(release, release);
  return pending;
}

export function registerEpicTerminalCloseAuthority(
  authority: EpicTerminalCloseAuthority,
): () => void {
  authorityByInstanceId.set(authority.instanceId, authority);
  return () => {
    if (authorityByInstanceId.get(authority.instanceId) === authority) {
      authorityByInstanceId.delete(authority.instanceId);
    }
  };
}

/**
 * Splits a close gesture into presentation-local removals and host-owned
 * semantic closures. Unknown, stale, unreachable, or unregistered terminal
 * authority fails closed. A batch addresses each lifetime terminal once.
 */
export function requestEpicTerminalClose(
  refs: readonly EpicCanvasTileRef[],
): EpicTerminalCloseRequest {
  const localInstanceIds: string[] = [];
  const retainedInstanceIds: string[] = [];
  const requestedLifetimeKeys = new Set<string>();

  for (const ref of refs) {
    if (ref.type !== "terminal") {
      localInstanceIds.push(ref.instanceId);
      continue;
    }
    const authority = authorityByInstanceId.get(ref.instanceId);
    if (
      authority === undefined ||
      authority.hostId !== ref.hostId ||
      authority.terminalId !== ref.id
    ) {
      retainedInstanceIds.push(ref.instanceId);
      continue;
    }
    if (authority.capability === "legacy") {
      localInstanceIds.push(ref.instanceId);
      continue;
    }
    if (authority.capability !== "capable" || !authority.canMutate) {
      retainedInstanceIds.push(ref.instanceId);
      continue;
    }

    retainedInstanceIds.push(ref.instanceId);
    const key = lifetimeKey(authority.hostId, authority.terminalId);
    if (requestedLifetimeKeys.has(key)) {
      continue;
    }
    requestedLifetimeKeys.add(key);
    const pending = requestEpicTerminalLifetimeClose(authority);
    if (pending !== null) void pending.catch(() => undefined);
  }

  return { localInstanceIds, retainedInstanceIds };
}
