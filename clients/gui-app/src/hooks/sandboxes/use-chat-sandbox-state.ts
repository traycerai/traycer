import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import {
  useTaskSandboxHost,
  type TaskSandboxHost,
} from "@/hooks/epic/use-task-sandbox-end";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import {
  sandboxConfigurationOf,
  useSandboxConfigurations,
} from "@/hooks/sandboxes/use-sandbox-configurations";
import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";
import { useSampledNow } from "@/lib/relative-time";
import { useAuthStore } from "@/stores/auth/auth-store";

/** Sandbox state precedes generic transport reachability on every chat copy. */
export function useChatSandboxState(
  epicId: string,
  hostId: string | null,
  reachable: boolean,
): ChatSandboxState {
  const task = useTaskSandboxHost(epicId, hostId);
  const list = useSandboxList();
  const configurations = useSandboxConfigurations();
  const entry = useHostDirectoryEntry(hostId);
  const viewerId = useAuthStore((state) => state.profile?.userId ?? null);
  const now = useSampledNow();
  if (task.kind === "ended") return { kind: "destroyed", ended: task.ended };
  const sandbox = list.data?.sandboxes.find((row) => row.hostId === hostId);
  if (sandbox === undefined)
    return unlistedHostState(task, entry, list.isLoading);
  if (
    sandbox.state === "suspended" ||
    sandbox.state === "stopped" ||
    sandbox.frozen
  ) {
    const configuration = sandboxConfigurationOf(
      sandbox,
      configurations.configurations,
    );
    if (configuration === null)
      return { kind: "pending", name: sandbox.displayName };
    return {
      kind: "resting",
      sandbox,
      configuration,
      wakeChangesPayer:
        configuration.kind === "team" &&
        sandbox.wakePayer !== null &&
        sandbox.wakePayer.userId !== viewerId,
    };
  }
  if (sandbox.state === "awake") {
    return reachable
      ? { kind: "none" }
      : {
          kind: "unreachable",
          sandbox,
          lastContactMinutes: minutesSinceContact(entry, now),
        };
  }
  return unsettledSandboxState(sandbox);
}

/** A listed sandbox neither resting nor awake. */
function unsettledSandboxState(sandbox: SandboxSummary): ChatSandboxState {
  switch (sandbox.state) {
    case "creating":
    case "resuming":
    case "starting":
    case "suspending":
    case "stopping":
    case "destroying":
      return { kind: "moving", sandbox, state: sandbox.state };
    default:
      // Destroyed before the task records its end, failed, or released.
      return { kind: "pending", name: sandbox.displayName };
  }
}

/**
 * A host the viewer's sandbox list does not hold: a sandbox when the
 * directory or the task names one, not a sandbox when either knows the host
 * as anything else, and unknown while a read that could say is still out.
 */
function unlistedHostState(
  task: TaskSandboxHost,
  entry: HostDirectoryEntry | null,
  listLoading: boolean,
): ChatSandboxState {
  if (task.kind === "sandbox") return { kind: "pending", name: task.name };
  if (entry !== null) {
    return isRemoteHostDirectoryEntry(entry) && entry.sandbox !== null
      ? { kind: "pending", name: entry.label }
      : { kind: "none" };
  }
  if (task.kind === "loading" || listLoading)
    return { kind: "pending", name: null };
  return { kind: "none" };
}

function minutesSinceContact(
  entry: HostDirectoryEntry | null,
  now: number,
): number | null {
  const seen =
    entry !== null && isRemoteHostDirectoryEntry(entry)
      ? entry.remoteStatus.lastSeenAt
      : null;
  if (seen === null) return null;
  const at = Date.parse(seen);
  return Number.isFinite(at)
    ? Math.max(0, Math.floor((now - at) / 60_000))
    : null;
}
