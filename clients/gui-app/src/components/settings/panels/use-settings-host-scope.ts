import { useMemo, useState } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { settingsHostLabelFor } from "./settings-host-labels";

export type SettingsHostScopeStatus =
  "default" | "connecting" | "unavailable" | "ready";

export interface SettingsHostScope {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly effectiveId: string | null;
  readonly setSelectedId: (hostId: string | null) => void;
  readonly hostLabel: string;
  /**
   * - `default`: no override - the panel is scoped to the active host.
   * - `connecting`: a non-active host is picked and its transient client is
   *   still being built - `client` is `null`; callers must not fall back to
   *   the active host meanwhile.
   * - `unavailable`: the picked host no longer appears in the directory
   *   (deregistered) - `client` is `null`; callers must show an explicit
   *   unavailable state, not silently read/write through the active host.
   * - `ready`: the picked host resolved to a live client.
   */
  readonly status: SettingsHostScopeStatus;
  readonly client: HostClient<HostRpcRegistry> | null;
}

/**
 * Shared host-scope derivation for Settings surfaces that let the user pick a
 * host other than the active one (File edit snapshots, Agent instructions).
 * Distinguishes "no override" from "override still connecting" from
 * "override vanished from the directory" from "override resolved" so callers
 * never silently substitute the active host's client for a destructive
 * action or an editor bound to a different host's file.
 */
export function useSettingsHostScope(): SettingsHostScope {
  const defaultClient = useHostClient();
  const activeHostId = useReactiveActiveHostId();
  const hostsQuery = useHostDirectoryList();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? activeHostId;
  const isOverridden = effectiveId !== null && effectiveId !== activeHostId;
  const selectedEntry = useMemo(
    () =>
      effectiveId === null
        ? null
        : (hosts.find((entry) => entry.hostId === effectiveId) ?? null),
    [hosts, effectiveId],
  );
  const targetEntry = isOverridden ? selectedEntry : null;
  const transientClient = useHostClientFor(targetEntry);
  const hostLabel = settingsHostLabelFor(hosts, effectiveId);

  const status = deriveSettingsHostScopeStatus(isOverridden, {
    selectedEntry,
    transientClient,
  });
  // `transientClient` is already `null` for both "connecting" and
  // "unavailable" (neither state has a `targetEntry` to resolve against), so
  // only the "default" branch needs to swap in the ambient client.
  const client = status === "default" ? defaultClient : transientClient;

  return { hosts, effectiveId, setSelectedId, hostLabel, status, client };
}

function deriveSettingsHostScopeStatus(
  isOverridden: boolean,
  target: {
    readonly selectedEntry: HostDirectoryEntry | null;
    readonly transientClient: HostClient<HostRpcRegistry> | null;
  },
): SettingsHostScopeStatus {
  if (!isOverridden) return "default";
  if (target.selectedEntry === null) return "unavailable";
  if (target.transientClient === null) return "connecting";
  return "ready";
}
