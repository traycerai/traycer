import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { useEffect, useRef } from "react";
import { type Query, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  EnvironmentLocalOverridesResponse,
  EnvironmentNoticesResponse,
  EnvironmentReviewResponse,
  EnvironmentReviewResponseV11,
  EnvironmentStatusResponseV12,
} from "@traycer/protocol/host/environment-schemas";
import {
  readNotices,
  readReviewHolds,
  type ReviewHeldEntry,
} from "@traycer-clients/shared/environment/environment-review";
import {
  ENVIRONMENT_CLOUD_QUERY_SCOPE,
  useEnvironmentCloudOwnRead,
} from "@/hooks/environment/use-environment-cloud";
import {
  CONFIGURATION_READS,
  configurationReadMatches,
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

/**
 * `environment.status`, re-read while mounted at the cadence its policy
 * declares: the steady one, and the move's own while this computer's move
 * into Personal is still running, since this read is that move's only
 * progress (`host-method-policy-table.ts`).
 */
export function useEnvironmentStatusRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentStatusResponseV12> {
  const supported = useHostMethodSupport(hostId, "environment.status");
  const query = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: enabled && supported === true, poll: true },
  });
  const personal = usePersonalEnvironment(
    enabled && query.data?.principal?.kind === "personal",
  );
  useRereadOnRevision(hostId, query.data ?? null, personal.environmentId);
  return { supported, data: query.data ?? null, isError: query.isError };
}

/** An app-made read of a {@link DELTA_FED_READS} method whose params name `hostId`. */
function aboutThisHost(
  queryKey: readonly unknown[],
  hostId: string | null,
): boolean {
  if (hostId === null) return false;
  if (queryKey[0] !== "host" || queryKey[1] !== ENVIRONMENT_CLOUD_QUERY_SCOPE)
    return false;
  const params = queryKey[3];
  return (
    DELTA_FED_READS.some((method) => queryKey[2] === method) &&
    typeof params === "object" &&
    params !== null &&
    "hostId" in params &&
    params.hostId === hostId
  );
}

/**
 * Re-reads the host's {@link DELTA_FED_READS} when its polled status reports
 * a new revision of the person's settings: a change made in the dashboard
 * reaches the host as a revision, and those reads are not re-read otherwise.
 * On a host that runs Personal, Personal's configuration reads move with it,
 * on every host that read them (`personalEnvironmentId`, `null` elsewhere).
 * A read the app makes itself about this host (the review sheet, keyed by its
 * `hostId`) moves with it too, whatever environment the host runs. The first
 * status a reader sees for a host only records the revision.
 */
function useRereadOnRevision(
  hostId: string | null,
  status: EnvironmentStatusResponseV12 | null,
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
    const scopes = DELTA_FED_READS.map((method) =>
      hostQueryKeys.methodScope(
        hostRpcServingTierHostId(
          method,
          hostId,
          readProcessHostRpcTierPlan(),
          null,
        ),
        method,
      ),
    );
    const filters = {
      predicate: (query: Query) =>
        scopes.some((scope) =>
          scope.every((part, index) => query.queryKey[index] === part),
        ) ||
        (personalEnvironmentId !== null &&
          configurationReadMatches(
            query.queryKey,
            personalEnvironmentId,
            CONFIGURATION_READS,
          )) ||
        aboutThisHost(query.queryKey, hostId),
    };
    // Retire an initial GET before refreshing; overlapping read sets must refresh once.
    void queryClient
      .cancelQueries(filters)
      .then(() => queryClient.invalidateQueries(filters))
      .catch(ignoreError);
  }, [hostId, revision, personalEnvironmentId, queryClient]);
}

/**
 * Personal's notices with their Undo, read by the app itself from authn on
 * the person's sign-in; `enabled` false on a host that does not run Personal.
 */
export function useEnvironmentNoticesRead(
  enabled: boolean,
): EnvironmentRead<EnvironmentNoticesResponse> {
  const personal = usePersonalEnvironment(enabled);
  const environmentId = personal.environmentId;
  const query = useEnvironmentCloudOwnRead({
    method: "environment.notices",
    params: { environmentId: environmentId ?? "" },
    read: async (cloud) => ({
      notices: await readNotices(cloud, environmentId ?? ""),
    }),
    enabled: enabled && environmentId !== null,
  });
  return { supported: true, data: query.data ?? null, isError: query.isError };
}

/** The review sheet's answer: authn's holds and its host's own three facts. */
export type EnvironmentReviewSheet = Omit<
  EnvironmentReviewResponseV11,
  "entries"
> & {
  readonly entries: readonly ReviewHeldEntry[];
  /**
   * Whether the host's answer carried its own record (`environment.review@1.1`
   * or later); until then, and from an older host, its three facts read null.
   */
  readonly recorded: boolean;
};

/** A host below `environment.review@1.1` answers its `entries` alone, with no record. */
function isReviewV11(
  review: EnvironmentReviewResponse,
): review is EnvironmentReviewResponseV11 {
  return "shownAt" in review && "evidence" in review;
}

/**
 * The review sheet for the host `hostId`: Personal's holds, read by the app
 * itself from authn's operation view, with that host's own record of the sheet
 * (`shownAt`, `acknowledgedAt`, `evidence`) from the top of its
 * `environment.review` answer. With that host unreachable the three read null,
 * as a host with no record answers them; its `entries` are not read.
 */
export function useEnvironmentReviewRead(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  enabled: boolean,
): EnvironmentRead<EnvironmentReviewSheet> {
  const personal = usePersonalEnvironment(enabled);
  const environmentId = personal.environmentId;
  const holds = useEnvironmentCloudOwnRead({
    method: "environment.review",
    // The sheet's host is in the key: its revision report re-reads this one.
    params: { environmentId: environmentId ?? "", hostId },
    read: (cloud) => readReviewHolds(cloud, environmentId ?? ""),
    enabled: enabled && environmentId !== null,
  });
  const supported = useHostMethodSupport(hostId, "environment.review");
  const record = useHostQuery<HostRpcRegistry, "environment.review">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.review",
    params: {},
    options: { enabled: enabled && supported === true },
  });
  // Waits only for a record read under way; one that cannot be sent reads null.
  const recordPending =
    record.data === undefined && record.fetchStatus === "fetching";
  const recorded =
    record.data !== undefined && isReviewV11(record.data) ? record.data : null;
  const data: EnvironmentReviewSheet | null =
    holds.data === undefined || recordPending
      ? null
      : {
          shownAt: recorded?.shownAt ?? null,
          acknowledgedAt: recorded?.acknowledgedAt ?? null,
          evidence: recorded?.evidence ?? { version: null, at: null },
          entries: holds.data,
          recorded: recorded !== null,
        };
  return { supported: true, data, isError: holds.isError };
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
