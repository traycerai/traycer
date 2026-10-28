import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  readHostDirectoryEntry,
  subscribeHostRowChanged,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";

/**
 * The team that owns a host, from the person's host directory (the registry
 * `owner`), or `null` for a host no team owns and while the directory cannot
 * say. Read through the context-free registry, since the picker also renders
 * where no host runtime is mounted.
 */
export function useHostOwnerTeamId(hostId: string | null): string | null {
  const subscribe = useCallback(
    (callback: () => void) =>
      hostId === null
        ? () => undefined
        : subscribeHostRowChanged(hostId, callback),
    [hostId],
  );
  const getSnapshot = useCallback(() => {
    if (hostId === null) return null;
    const entry = readHostDirectoryEntry(hostId);
    if (entry === null || !isRemoteHostDirectoryEntry(entry)) return null;
    return entry.sandbox?.ownerTeamId ?? null;
  }, [hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Whether a host is a team's sandbox. */
export function useOnTeamSandbox(hostId: string | null): boolean {
  return useHostOwnerTeamId(hostId) !== null;
}

/**
 * The configuration a sandbox host was created in, from the person's host
 * directory, or `null` for a host that is not a sandbox and while the
 * directory cannot say.
 */
export function useSandboxHostConfiguration(
  hostId: string | null,
): StageConfiguration | null {
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
    const { ownerTeamId, ownerTeamName } = entry.sandbox;
    return ownerTeamId === null
      ? PERSONAL_SNAPSHOT
      : `${ownerTeamId}${TEAM_SEPARATOR}${ownerTeamName ?? ""}`;
  }, [hostId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo((): StageConfiguration | null => {
    if (snapshot === null) return null;
    if (snapshot === PERSONAL_SNAPSHOT) return PERSONAL_CONFIGURATION;
    const at = snapshot.indexOf(TEAM_SEPARATOR);
    return {
      kind: "team",
      teamId: snapshot.slice(0, at),
      teamName: snapshot.slice(at + TEAM_SEPARATOR.length),
    };
  }, [snapshot]);
}

/** A team id is never empty and holds no NUL, so the two cannot collide. */
const PERSONAL_SNAPSHOT = "\u0000personal";
const TEAM_SEPARATOR = "\u0000";
const PERSONAL_CONFIGURATION: StageConfiguration = { kind: "personal" };
