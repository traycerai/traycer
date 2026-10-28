import type { TaskSandboxEnd } from "@traycer/protocol/host/task-host-summary";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";

export interface TaskSandboxEndedHost {
  readonly name: string;
  readonly end: TaskSandboxEnd;
}

/**
 * What the task says of one of its hosts:
 *
 * - `ended` - a sandbox's permanent end, which survives removal from the live
 *   sandbox and host lists;
 * - `sandbox` - a sandbox the task names, with no end;
 * - `person` - a host the task's answered list names as a person's;
 * - `unknown` - anything that proves nothing: the hosts are loading, failed,
 *   unsupported or disabled, or the list does not hold this host.
 */
export type TaskSandboxHost =
  | { readonly kind: "ended"; readonly ended: TaskSandboxEndedHost }
  | { readonly kind: "sandbox"; readonly name: string }
  | { readonly kind: "person" }
  | { readonly kind: "unknown" };

export function useTaskSandboxHost(
  epicId: string,
  hostId: string | null,
): TaskSandboxHost {
  const taskHosts = useTaskHostsView(epicId);
  if (hostId === null || taskHosts.kind !== "hosts") return { kind: "unknown" };
  const host = taskHosts.hosts.find((row) => row.hostId === hostId);
  if (host === undefined) return { kind: "unknown" };
  // `label` is a sandbox's display name, null for a person's host.
  if (host.label === null) return { kind: "person" };
  return host.sandboxEnd === null
    ? { kind: "sandbox", name: host.label }
    : { kind: "ended", ended: { name: host.label, end: host.sandboxEnd } };
}
