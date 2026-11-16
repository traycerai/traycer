import { useId } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  classifyHostRequestFailure,
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  providersCommitProfileMoveResponseSchema,
  type ProvidersCommitProfileMoveRequest,
  type ProvidersCommitProfileMoveResponse,
  type ProvidersPreviewProfileMoveRequest,
  type ProvidersPreviewProfileMoveResponse,
} from "@traycer/protocol/host/profile-move-schemas";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { isHostTransportFailure } from "@/lib/host-error-toast";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";

interface ProfileMoveHostCommit {
  readonly hostId: string | null;
  readonly request: ProvidersCommitProfileMoveRequest;
}

export interface ProfileMoveCommitPlan {
  readonly anchorHostId: string | null;
  readonly request: ProvidersCommitProfileMoveRequest;
  readonly groups: readonly ProfileMoveHostCommit[];
}

/** Freeze routing and ordered journal bodies together with the confirmed operation. */
export function createProfileMoveCommitPlan(
  request: Omit<ProvidersCommitProfileMoveRequest, "extent" | "targets">,
  targets: readonly ProvidersPreviewProfileMoveResponse["targets"][number][],
  anchorHostId: string | null,
): ProfileMoveCommitPlan {
  const groups = new Map<string | null, ProvidersCommitProfileMoveRequest>();
  const refs: ProvidersCommitProfileMoveRequest["targets"] = [];
  for (const target of targets) {
    const hostId = target.kind === "bot" ? anchorHostId : target.hostId;
    const ref =
      target.kind === "bot"
        ? { kind: "bot" as const, botId: target.botId }
        : {
            kind: "agent" as const,
            epicId: target.epicId,
            agentId: target.agentId,
          };
    let group = groups.get(hostId);
    if (group === undefined) {
      group = { ...request, extent: "this-computer", targets: [] };
      groups.set(hostId, group);
    }
    group.targets.push(ref);
    refs.push(ref);
  }
  return {
    anchorHostId,
    request: { ...request, extent: "this-computer", targets: refs },
    groups: [...groups].map(([hostId, body]) => ({ hostId, request: body })),
  };
}

function targetKey(
  target: ProvidersCommitProfileMoveRequest["targets"][number],
): string {
  return target.kind === "bot"
    ? JSON.stringify([target.kind, target.botId])
    : JSON.stringify([target.kind, target.epicId, target.agentId]);
}

function assertGroupResponse(
  response: ProvidersCommitProfileMoveResponse,
  request: ProvidersCommitProfileMoveRequest,
): void {
  const expected = new Set(request.targets.map(targetKey));
  if (
    response.operationId !== request.operationId ||
    response.extent !== "this-computer" ||
    response.mode !== request.mode ||
    response.results.length !== expected.size ||
    response.results.some((row) => !expected.has(targetKey(row.target)))
  )
    throw new Error("The other computer answered a different move.");
}

function failureOutcome(
  error: HostRpcError,
): "pending" | "unsupported" | "not-allowed" {
  if (isHostTransportFailure(error)) return "pending";
  if (
    error.code === "E_HOST_UNSUPPORTED" ||
    classifyHostRequestFailure(error).kind === "downgrade-unsupported"
  )
    return "unsupported";
  if (error.code === "FORBIDDEN" || error.code === "E_ROLE_FORBIDDEN")
    return "not-allowed";
  throw error;
}

export function useProvidersPreviewProfileMove(
  client: HostClient<HostRpcRegistry> | null,
  request: ProvidersPreviewProfileMoveRequest,
  enabled: boolean,
) {
  const previewId = useId();
  return useHostQuery<HostRpcRegistry, "providers.previewProfileMove">({
    client,
    cacheKeyIdentity: [previewId],
    method: "providers.previewProfileMove",
    requiredHostMethodVersion: () => ({
      method: "providers.previewProfileMove",
      version: { major: 1, minor: 0 },
    }),
    params: request,
    options: {
      enabled,
      staleTime: Infinity,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  });
}

export function useProvidersCommitProfileMove(
  client: HostClient<HostRpcRegistry> | null,
) {
  const queryClient = useQueryClient();
  const local = useHostMutation<
    HostRpcRegistry,
    "providers.commitProfileMove",
    unknown,
    ProfileMoveHostCommit
  >({
    client: (group) => {
      if (client === null || group.hostId === null) return null;
      const named = resolveNamedHostClient(
        { hostClient: client },
        group.hostId,
      );
      if (named?.getActiveHost() === null)
        throw new HostTransportFailureError({
          code: "RPC_ERROR",
          message: "Cannot call host RPC without an active host",
          requestId: "client-preflight",
          method: "providers.commitProfileMove",
          fatalDetails: null,
        });
      return named;
    },
    method: "providers.commitProfileMove",
    mapVariables: (group) => group.request,
    requiredHostMethodVersion: () => ({
      method: "providers.commitProfileMove",
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey: providersMutationKeys.commitProfileMove(),
      retry: false,
      onSettled: (_data, _error, group) => {
        if (group.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            hostRpcServingTierHostId(
              "agent.list",
              group.hostId,
              readProcessHostRpcTierPlan(),
              null,
            ),
            "agent.list",
          ),
        });
      },
    },
  });
  return useMutation<
    ProvidersCommitProfileMoveResponse,
    HostRpcError,
    ProfileMoveCommitPlan
  >({
    mutationKey: providersMutationKeys.commitProfileMove(),
    retry: false,
    mutationFn: (plan) =>
      withHostQueryErrorBoundary("providers.commitProfileMove", async () => {
        const results = new Map<
          string,
          ProvidersCommitProfileMoveResponse["results"][number]
        >();
        let answered = false;
        let fallbackError: HostRpcError | null = null;
        for (const group of plan.groups) {
          let response: ProvidersCommitProfileMoveResponse;
          try {
            response = providersCommitProfileMoveResponseSchema.parse(
              await local.mutateAsync(group),
            );
          } catch (error) {
            if (!(error instanceof HostRpcError)) throw error;
            const outcome = failureOutcome(error);
            if (fallbackError === null || group.hostId === plan.anchorHostId)
              fallbackError = error;
            for (const target of group.request.targets) {
              results.set(
                targetKey(target),
                outcome === "pending"
                  ? { target, row: null, outcome: "pending" }
                  : {
                      target,
                      row: null,
                      outcome: "skipped",
                      reason: outcome,
                    },
              );
            }
            continue;
          }
          assertGroupResponse(response, group.request);
          answered = true;
          for (const row of response.results)
            results.set(targetKey(row.target), row);
        }
        if (!answered && fallbackError !== null) throw fallbackError;
        return providersCommitProfileMoveResponseSchema.parse({
          operationId: plan.request.operationId,
          extent: "this-computer",
          mode: plan.request.mode,
          results: plan.request.targets.map((target) =>
            results.get(targetKey(target)),
          ),
        });
      }),
  });
}
