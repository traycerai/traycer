import { useEffect } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  HostRpcError,
  RequiredHostMethodVersion,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-ids";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { startVisibleInterval } from "@/lib/dom/visible-interval";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

type LinkMethod = "providers.link" | "providers.linkComplete";
type LinkCompleteResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.linkComplete"
>;

/**
 * Linking a plan into a team's configuration: `providers.link@1.1` and
 * `providers.linkComplete@1.1` carry the team's `environmentId`, so an older
 * host refuses the request before it is sent rather than linking the plan
 * into its own environment.
 */
function teamLinkFloor(method: LinkMethod): RequiredHostMethodVersion {
  return { method, version: { major: 1, minor: 1 } };
}

/** A linked plan changes the team's Plans card and its provider items. */
function rereadLinkedPlan(
  queryClient: QueryClient,
  hostId: string | null,
  environmentId: string,
): void {
  for (const method of [
    "environment.plans.list",
    "environment.configuration.items",
  ] as const) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.method(hostId, method, { environmentId }),
    });
  }
}

export interface TeamPlanLinkStart {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
}

export function useTeamPlanLinkStartMutation(
  environmentId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.link">,
  HostRpcError,
  TeamPlanLinkStart
> {
  const client = usePoolTierHostClient(useHostClient());
  return useHostMutation<
    HostRpcRegistry,
    "providers.link",
    unknown,
    TeamPlanLinkStart
  >({
    client,
    method: "providers.link",
    mapVariables: (variables) => {
      cloudVerdictPreflight("providers.link")();
      return { ...variables, environmentId };
    },
    requiredHostMethodVersion: () => teamLinkFloor("providers.link"),
    options: { mutationKey: environmentMutationKeys.providersLink() },
  });
}

/**
 * Sends the code the person pasted. `readCode` is read at dispatch so the
 * code, a one-time credential, never becomes the mutation's variables and
 * reaches no query or mutation cache.
 */
export function useTeamPlanLinkCompleteMutation(
  environmentId: string,
  readCode: () => string,
): UseMutationResult<
  LinkCompleteResponse,
  HostRpcError,
  string,
  { readonly hostId: string | null }
> {
  const client = usePoolTierHostClient(useHostClient());
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.linkComplete",
    { readonly hostId: string | null },
    string
  >({
    client,
    method: "providers.linkComplete",
    mapVariables: (linkId) => {
      cloudVerdictPreflight("providers.linkComplete")();
      return { linkId, code: readCode(), environmentId };
    },
    requiredHostMethodVersion: () => teamLinkFloor("providers.linkComplete"),
    options: {
      mutationKey: environmentMutationKeys.providersLinkComplete(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (response, _linkId, context) => {
        if (response.state === "linked") {
          rereadLinkedPlan(queryClient, context.hostId, environmentId);
        }
      },
    },
  });
}

/**
 * Asks after a device code or a local handoff when `linkId` is set, then
 * every `intervalMs` while the answer is `pending`; `linkId` `null` asks
 * nothing. The method is unpolled (a device code and a handoff settle at
 * different cadences), so the reread is this hook's own, as the Personal
 * page chip's is. Once linked, the team's plans are reread.
 */
export function useTeamPlanLinkPollQuery(
  environmentId: string,
  linkId: string | null,
  intervalMs: number,
): UseQueryResult<LinkCompleteResponse, HostRpcError> {
  const client = usePoolTierHostClient(useHostClient());
  const queryClient = useQueryClient();
  const poll = useHostQuery({
    client,
    method: "providers.linkComplete",
    params: { linkId: linkId ?? "", code: null, environmentId },
    cacheKeyIdentity: undefined,
    preflight: cloudVerdictPreflight("providers.linkComplete"),
    requiredHostMethodVersion: () => teamLinkFloor("providers.linkComplete"),
    options: {
      enabled: linkId !== null,
      // One link id is one sign-in; nothing else reads its answer.
      gcTime: 0,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    },
  });
  const pending = linkId !== null && poll.data?.state === "pending";
  const { refetch } = poll;
  useEffect(() => {
    if (!pending) return;
    return startVisibleInterval({
      tick: () => {
        void refetch({ cancelRefetch: false });
      },
      intervalMs,
      fireOnShow: true,
    });
  }, [pending, refetch, intervalMs]);
  const linked = poll.data?.state === "linked";
  useEffect(() => {
    if (linked) {
      rereadLinkedPlan(queryClient, client.getActiveHostId(), environmentId);
    }
  }, [linked, queryClient, client, environmentId]);
  return poll;
}
