import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { isRemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { useTaskSandboxEnd } from "@/hooks/epic/use-task-sandbox-end";
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
  const ended = useTaskSandboxEnd(epicId, hostId);
  const list = useSandboxList();
  const configurations = useSandboxConfigurations();
  const entry = useHostDirectoryEntry(hostId);
  const viewerId = useAuthStore((state) => state.profile?.userId ?? null);
  const now = useSampledNow();
  if (ended !== null) return { kind: "destroyed", ended };
  const sandbox = list.data?.sandboxes.find((row) => row.hostId === hostId);
  if (sandbox === undefined) return { kind: "none" };
  if (
    sandbox.state === "suspended" ||
    sandbox.state === "stopped" ||
    sandbox.frozen
  ) {
    const configuration = sandboxConfigurationOf(
      sandbox,
      configurations.configurations,
    );
    if (configuration === null) return { kind: "none" };
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
  if (sandbox.state === "awake" && !reachable) {
    return {
      kind: "unreachable",
      sandbox,
      lastContactMinutes: minutesSinceContact(entry, now),
    };
  }
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
