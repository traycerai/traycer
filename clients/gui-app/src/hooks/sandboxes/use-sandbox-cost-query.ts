import { useEffect, useRef } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  SandboxCost,
  SandboxSummary,
} from "@traycer/protocol/host/sandbox-control";
import {
  refreshSandboxCostQueries,
  SANDBOX_COST_REFRESH_MS,
} from "@/hooks/sandboxes/refresh-sandbox-cost-queries";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";

export function sandboxCostQueryOptions(
  auth: AuthService,
  userId: string | null,
  sandboxId: string,
) {
  return queryOptions<SandboxCost | null>({
    queryKey: sandboxQueryKeys.cost(auth, userId, sandboxId),
    queryFn: async () => {
      const result = await auth.getSandboxCost(sandboxId);
      if (result.kind === "ok") return result.cost;
      throw new Error(sandboxFailureMessage(result));
    },
    staleTime: 0,
    retry: false,
  });
}

/** Mounted by an open Details drawer, never by the list or a card. */
export function useSandboxCost(
  summary: SandboxSummary,
  accruing: boolean,
): UseQueryResult<SandboxCost | null> {
  const auth = useHostBinding()?.auth ?? null;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  const enabled = auth !== null && signedIn && !unavailable;
  const client = useQueryClient();
  const { id, state, frozen, lastTransitionAt } = summary;
  const previous = useRef<{
    readonly auth: AuthService;
    readonly userId: string | null;
    readonly sandboxId: string;
    readonly state: string;
    readonly frozen: boolean;
    readonly lastTransitionAt: number;
  } | null>(null);
  useEffect(() => {
    if (!enabled) {
      previous.current = null;
      return;
    }
    const prior = previous.current;
    previous.current = {
      auth,
      userId,
      sandboxId: id,
      state,
      frozen,
      lastTransitionAt,
    };
    if (
      prior?.auth === auth &&
      prior.userId === userId &&
      prior.sandboxId === id &&
      (prior.state !== state ||
        prior.frozen !== frozen ||
        prior.lastTransitionAt !== lastTransitionAt)
    ) {
      refreshSandboxCostQueries(
        client,
        sandboxQueryKeys.cost(auth, userId, id),
      );
    }
  }, [auth, userId, id, state, frozen, lastTransitionAt, client, enabled]);
  return useQuery<SandboxCost | null>(
    auth === null
      ? {
          queryKey: sandboxQueryKeys.costMissing(),
          enabled: false,
          queryFn: () => null,
        }
      : {
          ...sandboxCostQueryOptions(auth, userId, id),
          enabled,
          refetchOnMount: "always",
          refetchInterval: accruing ? SANDBOX_COST_REFRESH_MS : false,
          refetchIntervalInBackground: false,
        },
  );
}
