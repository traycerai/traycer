import { plainTerminalFleetIdentityKey } from "@traycer/protocol/host/terminal/plain-schemas";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

export interface EpicTerminalLifetimeCloseAuthority {
  readonly hostId: string;
  readonly terminalId: string;
  readonly capability: "unknown" | "legacy" | "capable";
  readonly canMutate: boolean;
  readonly close: () => Promise<void>;
}

export interface EpicTerminalCloseRequest {
  readonly localInstanceIds: readonly string[];
  readonly retainedInstanceIds: readonly string[];
}

const pendingByLifetimeKey = new Map<string, Promise<void>>();

function lifetimeKey(hostId: string, terminalId: string): string {
  return plainTerminalFleetIdentityKey({ hostId, terminalId });
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

/**
 * Canvas tab-close gestures remove local presentations only. They never
 * invoke a terminal-lifetime mutation, including for durable terminals that
 * are still starting or already running. Explicit sidebar/overlay delete uses
 * `requestEpicTerminalLifetimeClose` instead.
 */
export function requestEpicTerminalClose(
  refs: readonly EpicCanvasTileRef[],
): EpicTerminalCloseRequest {
  return {
    localInstanceIds: refs.map((ref) => ref.instanceId),
    retainedInstanceIds: [],
  };
}
