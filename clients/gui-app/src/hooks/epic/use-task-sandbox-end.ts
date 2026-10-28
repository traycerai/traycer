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
 * - `loading` - the task's hosts have not answered yet;
 * - `other` - a person's host, a host the task does not list, or a task that
 *   cannot say.
 */
export type TaskSandboxHost =
  | { readonly kind: "ended"; readonly ended: TaskSandboxEndedHost }
  | { readonly kind: "sandbox"; readonly name: string }
  | { readonly kind: "loading" }
  | { readonly kind: "other" };

export function useTaskSandboxHost(
  epicId: string,
  hostId: string | null,
): TaskSandboxHost {
  const taskHosts = useTaskHostsView(epicId);
  if (hostId === null) return { kind: "other" };
  if (taskHosts.kind === "loading") return { kind: "loading" };
  if (taskHosts.kind !== "hosts") return { kind: "other" };
  const host = taskHosts.hosts.find((row) => row.hostId === hostId);
  // `label` is a sandbox's display name, null for a person's host.
  if (host === undefined || host.label === null) return { kind: "other" };
  return host.sandboxEnd === null
    ? { kind: "sandbox", name: host.label }
    : { kind: "ended", ended: { name: host.label, end: host.sandboxEnd } };
}
