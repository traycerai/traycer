import type { HostSandboxState } from "@traycer/protocol/host/host-status";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { hostLastReport } from "@/components/settings/host-scope/host-last-report";
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
import { useSandboxWakeWait } from "@/hooks/sandboxes/use-sandbox-wake-wait";
import { useAuthStore } from "@/stores/auth/auth-store";

/** A chat's reach to its host is `reachable`; the list shows the wake. */
const CHAT_WAKE_SURFACE = { hostAnswered: null, wakeSent: false };

/**
 * Sandbox state precedes generic transport reachability on every chat copy:
 * the task's end record, then a listed row's state, then a sandbox something
 * names. A host nothing names as a sandbox is not one: the surface takes its
 * own path. An awake row whose host has not first reported is still moving;
 * only a host that reported and then stopped reads as unreachable.
 */
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
  const sandbox =
    list.data?.sandboxes.find((row) => row.hostId === hostId) ?? null;
  const wakeWait = useSandboxWakeWait(sandbox, CHAT_WAKE_SURFACE);
  if (hostId === null) return { kind: "none" };
  if (task.kind === "ended") return { kind: "destroyed", ended: task.ended };
  if (sandbox === null) return unlistedHostState(task, entry);
  if (
    sandbox.state === "suspended" ||
    sandbox.state === "stopped" ||
    sandbox.frozen
  ) {
    // The state is known without the configuration; only its bill waits.
    const configuration = sandboxConfigurationOf(
      sandbox,
      configurations.configurations,
    );
    return {
      kind: "resting",
      sandbox,
      configuration,
      wakeChangesPayer:
        configuration?.kind === "team" &&
        sandbox.wakePayer !== null &&
        sandbox.wakePayer.userId !== viewerId,
    };
  }
  if (sandbox.state === "awake") {
    if (reachable) return { kind: "none" };
    return wakeWait !== null
      ? { kind: "moving", sandbox, state: wakeWait }
      : { kind: "unreachable", sandbox, lastContactAt: lastContactAt(sandbox) };
  }
  return unsettledSandboxState(sandbox, sandbox.state);
}

function lastContactAt(sandbox: SandboxSummary): number | null {
  const report = hostLastReport(null, sandbox);
  return report.kind === "reported" ? report.at : null;
}

/** A listed sandbox neither resting nor awake. */
function unsettledSandboxState(
  sandbox: SandboxSummary,
  state: Exclude<HostSandboxState, "awake" | "suspended" | "stopped">,
): ChatSandboxState {
  switch (state) {
    case "failed":
      return { kind: "failed", sandbox };
    case "released":
      return { kind: "released", sandbox };
    case "destroyed":
      // Its end record has not reached the task yet.
      return { kind: "moving", sandbox, state: "destroying" };
    case "creating":
    case "resuming":
    case "starting":
    case "suspending":
    case "stopping":
    case "destroying":
      return { kind: "moving", sandbox, state };
  }
}

/**
 * A host the viewer's sandbox list does not hold, or a surface that cannot
 * read the list (a sidebar row): a sandbox, its state not known here, when
 * the task or the directory names one; otherwise not a sandbox.
 */
export function unlistedHostState(
  task: TaskSandboxHost,
  entry: HostDirectoryEntry | null,
): ChatSandboxState {
  if (task.kind === "sandbox") return { kind: "pending", name: task.name };
  return entry !== null &&
    isRemoteHostDirectoryEntry(entry) &&
    entry.sandbox !== null
    ? { kind: "pending", name: entry.label }
    : { kind: "none" };
}
