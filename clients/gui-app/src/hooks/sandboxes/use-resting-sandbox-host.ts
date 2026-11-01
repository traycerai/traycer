import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import {
  hostUnavailability,
  isRemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  wakeVerbFor,
  type SandboxWakeVerb,
} from "@traycer-clients/shared/host-client/sandbox-control";
import {
  comingUpPickLabel,
  restingPickLabel,
} from "@/lib/sandboxes/sandbox-strings";

/** A sandbox at rest, as a surface that sends to it names and wakes it. */
export interface RestingSandboxHost {
  readonly hostId: string;
  readonly name: string;
  readonly verb: SandboxWakeVerb;
}

/** The verb a sandbox already on its way up got there by. */
function comingUpVerb(state: HostSandboxState | null): SandboxWakeVerb | null {
  if (state === "resuming") return "resume";
  return state === "starting" ? "start" : null;
}

function useHostRowSubscribe(
  hostId: string | null,
): (callback: () => void) => () => void {
  return useCallback(
    (callback: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, callback),
    [hostId],
  );
}

/**
 * The sandbox `hostId` names while it rests or is on its way up, from the
 * person's host directory; `null` for any other host, and while the directory
 * cannot say. Read through the context-free registry, since a picker also
 * renders where no host runtime is mounted.
 */
export function useRestingSandboxHost(
  hostId: string | null,
): RestingSandboxHost | null {
  const subscribe = useHostRowSubscribe(hostId);
  // A string, so the snapshot is stable between reads of an unchanged row.
  const getSnapshot = useCallback((): string | null => {
    if (hostId === null) return null;
    const entry = readHostDirectoryEntry(hostId);
    if (entry === null || !isRemoteHostDirectoryEntry(entry)) return null;
    if (entry.sandbox === null) return null;
    const verb =
      wakeVerbFor(entry.sandbox.state) ??
      comingUpVerb(entry.sandbox.state) ??
      (entry.sandbox.frozen ? "resume" : null);
    return verb === null ? null : `${verb}${SEPARATOR}${entry.label}`;
  }, [hostId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo((): RestingSandboxHost | null => {
    if (hostId === null || snapshot === null) return null;
    const at = snapshot.indexOf(SEPARATOR);
    return {
      hostId,
      name: snapshot.slice(at + SEPARATOR.length),
      verb: snapshot.startsWith("start") ? "start" : "resume",
    };
  }, [hostId, snapshot]);
}

const SEPARATOR = "\u0000";

/**
 * What a host chip says of a sandbox that rests or is on its way up, for a
 * surface that would otherwise describe a link to it; `null` for any other
 * host, and while the directory cannot say.
 */
export function useSandboxRestLine(hostId: string | null): string | null {
  const subscribe = useHostRowSubscribe(hostId);
  const getSnapshot = useCallback((): string | null => {
    if (hostId === null) return null;
    const entry = readHostDirectoryEntry(hostId);
    if (entry === null || !isRemoteHostDirectoryEntry(entry)) return null;
    if (entry.sandbox === null) return null;
    const { state, frozen } = entry.sandbox;
    if (state === "resuming" || state === "starting") {
      return comingUpPickLabel(entry.label, state);
    }
    const verb = wakeVerbFor(state) ?? (frozen ? "resume" : null);
    return verb === null ? null : restingPickLabel(entry.label, verb);
  }, [hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Whether `hostId` is a sandbox this client cannot reach right now, whatever
 * the reason: what decides that a surface needs to read its row at all.
 */
export function useSandboxHostNotAnswering(hostId: string | null): boolean {
  const subscribe = useHostRowSubscribe(hostId);
  const getSnapshot = useCallback((): boolean => {
    if (hostId === null) return false;
    const entry = readHostDirectoryEntry(hostId);
    return (
      entry !== null &&
      isRemoteHostDirectoryEntry(entry) &&
      entry.sandbox !== null &&
      hostUnavailability(entry) !== null
    );
  }, [hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
