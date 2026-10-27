import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";

export interface TaskSandboxEndedHost {
  readonly name: string;
  readonly end: TaskSandboxEnd;
}

/** A permanent end survives removal from the live sandbox and host lists. */
export function useTaskSandboxEnd(
  epicId: string,
  hostId: string | null,
): TaskSandboxEndedHost | null {
  const taskHosts = useTaskHostsView(epicId);
  if (hostId === null || taskHosts.kind !== "hosts") return null;
  const host = taskHosts.hosts.find((row) => row.hostId === hostId);
  if (host === undefined || host.sandboxEnd === null || host.label === null)
    return null;
  return { name: host.label, end: host.sandboxEnd };
}
