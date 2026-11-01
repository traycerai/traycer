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

/**
 * The sandbox `hostId` names while it rests or is on its way up, from the
 * person's host directory; `null` for any other host, and while the directory
 * cannot say. Read through the context-free registry, since a picker also
 * renders where no host runtime is mounted.
 */
export function useRestingSandboxHost(
  hostId: string | null,
): RestingSandboxHost | null {
  const subscribe = useCallback(
    (callback: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, callback),
    [hostId],
  );
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
 * Whether `hostId` is a sandbox this client cannot reach right now, whatever
 * the reason: what decides that a surface needs to read its row at all.
 */
export function useSandboxHostNotAnswering(hostId: string | null): boolean {
  const subscribe = useCallback(
    (callback: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, callback),
    [hostId],
  );
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
