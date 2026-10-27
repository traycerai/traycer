import { useCallback, useMemo } from "react";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useHostDirectory } from "@/lib/host";
import type { TaskHomeDirectory } from "@/lib/terminals/terminal-title";

function taskHomeDirectory(
  epicId: string | null,
  hostName: string | null,
): TaskHomeDirectory | null {
  return epicId === null || hostName === null || hostName.length === 0
    ? null
    : { epicId, hostName };
}

/**
 * The task's own directory on `hostId`, named by that host, for a terminal
 * title. `null` outside a task, or while the host has no directory row.
 */
export function useTaskHomeDirectory(
  epicId: string | null,
  hostId: string | null,
): TaskHomeDirectory | null {
  const entry = useHostDirectoryEntry(hostId);
  const hostName = entry === null ? null : entry.label;
  return useMemo(() => taskHomeDirectory(epicId, hostName), [epicId, hostName]);
}

/**
 * The same, read when a row is opened rather than rendered: a list whose
 * rows can name several hosts resolves each one's at that moment.
 */
export function useTaskHomeDirectoryFor(
  epicId: string,
): (hostId: string) => TaskHomeDirectory | null {
  const directory = useHostDirectory();
  return useCallback(
    (hostId) =>
      taskHomeDirectory(epicId, directory.findById(hostId)?.label ?? null),
    [directory, epicId],
  );
}
