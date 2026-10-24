import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";

export type AgentHostProjection =
  | { readonly kind: "host"; readonly sandbox: SandboxSummary }
  | { readonly kind: "task"; readonly host: TaskHostRow };

/** A task row is never promoted to host authority by reachability. */
export function useAgentHostProjection(
  epicId: string,
  hostId: string | null,
): AgentHostProjection | null {
  const list = useSandboxList();
  const taskHosts = useTaskHostsView(epicId);
  if (hostId === null) return null;
  const sandbox = list.data?.sandboxes.find((row) => row.hostId === hostId);
  if (sandbox !== undefined) return { kind: "host", sandbox };
  if (taskHosts.kind !== "hosts") return null;
  const host = taskHosts.hosts.find((row) => row.hostId === hostId);
  // The task summary's label is non-null only for sandbox hosts. A computer
  // has no sandbox projection, even if its owner principal is another team.
  return host !== undefined && host.label !== null
    ? { kind: "task", host }
    : null;
}
