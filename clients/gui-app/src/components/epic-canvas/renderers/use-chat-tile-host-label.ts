import type { EnvironmentHostRecordV11 } from "@traycer/protocol/host/environment/contracts";
import {
  hostNameFromLabel,
  resolvedHostLabel,
  UNNAMED_HOST_LABEL,
  type HostReachability,
} from "@/hooks/agent/use-host-reachability";
import { useEnvironmentHostLists } from "@/hooks/bots/use-environment-host-lists-query";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useOptionalHostClient } from "@/lib/host";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

/**
 * The name a host reported to an environment it is bound to, if any. A label
 * that is blank or the id itself names nothing, so the search goes on.
 */
function environmentHostLabel(
  hostsByEnvironmentId: ReadonlyMap<
    string,
    ReadonlyArray<EnvironmentHostRecordV11>
  >,
  hostId: string,
): string | null {
  for (const hosts of hostsByEnvironmentId.values()) {
    const label = hosts.find((host) => host.hostId === hostId)?.hostLabel;
    const name = hostNameFromLabel(label ?? null, hostId);
    if (name !== UNNAMED_HOST_LABEL) return name;
  }
  return null;
}

/**
 * The name a chat tile gives its host, or `null` for "the host": the
 * directory's label, and for an unreachable host the directory has no name
 * for - one that left this device's directory, or a past identity - the label
 * the host reported to an environment of the account (`environment.host.list`).
 * Never the host id.
 *
 * Every environment is asked, Personal and each team: a personal machine
 * bound to a team is listed there, to the member who bound it, and not in
 * Personal's list. The reads go through the app-wide client, because the tab's
 * own host is the one that is offline, and only for a host the directory
 * cannot name; an older host without `environment.host.list` is not asked.
 */
export function useChatTileHostLabel(
  reachability: HostReachability,
  hostId: string,
): string | null {
  const directoryLabel = resolvedHostLabel(reachability);
  const client = useOptionalHostClient();
  const appHostId = client?.getActiveHostId() ?? null;
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const listSupport = useHostMethodSupport(appHostId, "environment.list");
  const hostListSupport = useHostMethodSupport(
    appHostId,
    "environment.host.list",
  );
  const enabled =
    directoryLabel === null &&
    reachability.status === "unreachable" &&
    authorized &&
    listSupport === true &&
    hostListSupport === true;
  const environments = useEnvironmentListQuery(client, enabled);
  // Fresh each render is fine: the lists key their requests by the ids' text.
  const environmentIds = enabled
    ? (environments.data?.environments ?? []).map(
        (environment) => environment.environmentId,
      )
    : [];
  const lists = useEnvironmentHostLists(client, environmentIds, enabled);
  // Off whenever the directory names the host, so this returns its label.
  if (!enabled) return directoryLabel;
  return environmentHostLabel(lists.hostsByEnvironmentId, hostId);
}
