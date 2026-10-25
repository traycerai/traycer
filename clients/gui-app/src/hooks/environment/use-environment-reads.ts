import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentLocalOverridesResponse,
  EnvironmentNoticesResponse,
  EnvironmentReviewResponse,
  EnvironmentStatusResponseV11,
} from "@traycer/protocol/host/environment-schemas";
import {
  CONFIGURATION_READS,
  invalidateConfigurationReads,
} from "@/hooks/environment/environment-host-list-key";
import { usePersonalEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { ignoreError } from "@/lib/browser-view/ignore-error";
import { DELTA_FED_READS } from "@/lib/environment/delta-fed-reads";
import { hostQueryKeys } from "@/lib/query-keys";

/*
 * A host's own environment reads, through the client the caller names: the
 * picked host on its Overview, the window's host on a Personal page. Each
 * answers `supported` from the host's handshake (`null` until it is known,
 * `false` for a version without the method) and the read's data, `null`
 * until it arrives. A read mounts only on a supported host.
 */

export interface EnvironmentRead<Data> {
  readonly supported: boolean | null;
  readonly data: Data | null;
  readonly isError: boolean;
}

/** `environment.status`, re-read while mounted at the cadence its policy declares. */
export function useEnvironmentStatusRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentStatusResponseV11> {
  const supported = useHostMethodSupport(hostId, "environment.status");
  const query = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: enabled && supported === true, poll: true },
  });
  const personal = usePersonalEnvironment(
    client,
    enabled && query.data?.principal?.kind === "personal",
  );
  useRereadOnRevision(hostId, query.data ?? null, personal.environmentId);
  return { supported, data: query.data ?? null, isError: query.isError };
}

/**
 * Re-reads the host's {@link DELTA_FED_READS} when its polled status reports
 * a new revision of the person's settings: a change made in the dashboard
 * reaches the host as a revision, and those reads are not re-read otherwise.
 * On a host that runs Personal, Personal's configuration reads move with it,
 * on every host that read them (`personalEnvironmentId`, `null` elsewhere).
 * The first status a reader sees for a host only records the revision.
 */
function useRereadOnRevision(
  hostId: string | null,
  status: EnvironmentStatusResponseV11 | null,
  personalEnvironmentId: string | null,
): void {
  const queryClient = useQueryClient();
  const seen = useRef<{
    readonly hostId: string | null;
    readonly revision: string;
  } | null>(null);
  const revision =
    status === null
      ? null
      : `${status.receivedRevision ?? "none"}:${status.appliedRevision ?? "none"}`;
  useEffect(() => {
    if (revision === null) return;
    const previous = seen.current;
    seen.current = { hostId, revision };
    if (previous === null || previous.hostId !== hostId) return;
    if (previous.revision === revision) return;
    for (const method of DELTA_FED_READS) {
      void queryClient
        .invalidateQueries({
          queryKey: hostQueryKeys.methodScope(hostId, method),
        })
        .catch(ignoreError);
    }
    if (personalEnvironmentId !== null)
      invalidateConfigurationReads(
        queryClient,
        personalEnvironmentId,
        CONFIGURATION_READS,
      );
  }, [hostId, revision, personalEnvironmentId, queryClient]);
}

export function useEnvironmentNoticesRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentNoticesResponse> {
  const supported = useHostMethodSupport(hostId, "environment.notices");
  const query = useHostQuery<HostRpcRegistry, "environment.notices">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.notices",
    params: {},
    options: { enabled: enabled && supported === true },
  });
  return { supported, data: query.data ?? null, isError: query.isError };
}

export function useEnvironmentReviewRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentReviewResponse> {
  const supported = useHostMethodSupport(hostId, "environment.review");
  const query = useHostQuery<HostRpcRegistry, "environment.review">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.review",
    params: {},
    options: { enabled: enabled && supported === true },
  });
  return { supported, data: query.data ?? null, isError: query.isError };
}

export function useEnvironmentLocalOverridesRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentLocalOverridesResponse> {
  const supported = useHostMethodSupport(hostId, "environment.localOverrides");
  const query = useHostQuery<HostRpcRegistry, "environment.localOverrides">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.localOverrides",
    params: {},
    options: { enabled: enabled && supported === true },
  });
  return { supported, data: query.data ?? null, isError: query.isError };
}
