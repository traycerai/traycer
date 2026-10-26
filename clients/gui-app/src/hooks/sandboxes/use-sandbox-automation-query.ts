import { useCallback } from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type {
  SandboxAutomationResponse,
  SandboxPod,
} from "@traycer/protocol/host/sandbox-control";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

function sandboxAutomationQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  environmentId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<SandboxAutomationResponse | null>({
      queryKey: sandboxQueryKeys.automationMissing(),
      queryFn: () => Promise.resolve(null),
      enabled: false,
    });
  }
  return queryOptions<SandboxAutomationResponse | null>({
    queryKey: sandboxQueryKeys.automation(auth, userId, environmentId),
    queryFn: async () => {
      const result = await auth.getSandboxAutomation(environmentId);
      if (result.kind === "ok") {
        return result.automation;
      }
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * `GET /api/sandboxes/automation`: whether this deployment offers
 * Automations, and the environment's rows: the person's own host
 * (`environmentId` null) or a team's pods. Enabled exactly when
 * `useSandboxList` is. A server without the route reads as
 * `{ available: false, sandbox: null, pods: [] }` (see
 * `getSandboxAutomationViaHttp`), so an older server shows no entry and no
 * error. One read per environment: every pod card of a team shares it.
 */
export function useSandboxAutomation(
  environmentId: string | null,
): UseQueryResult<SandboxAutomationResponse | null> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  // Without sandboxes (unread included) the control plane is never asked.
  const offered = usePreviewFeature("sandboxes") === "on";
  return useQuery(
    sandboxAutomationQueryOptions(
      auth,
      userId,
      environmentId,
      signedIn && !unavailable && offered,
    ),
  );
}

/**
 * The pod lists of several team environments, one read each and shared with
 * every `useSandboxAutomation(environmentId)` of the same environment (the
 * same query key): the new terminal picker's team pods. Keyed by
 * environment; one that has not answered is absent.
 */
export function useSandboxTeamPods(
  environmentIds: readonly string[],
): ReadonlyMap<string, readonly SandboxPod[]> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  // Without sandboxes (unread included) the control plane is never asked.
  const offered = usePreviewFeature("sandboxes") === "on";
  // Stable per id list, so the map is rebuilt only when a read answers.
  const combine = useCallback(
    (
      results: readonly UseQueryResult<SandboxAutomationResponse | null>[],
    ): ReadonlyMap<string, readonly SandboxPod[]> => {
      const pods = new Map<string, readonly SandboxPod[]>();
      environmentIds.forEach((environmentId, index) => {
        const data = results[index]?.data ?? null;
        if (data !== null) pods.set(environmentId, data.pods);
      });
      return pods;
    },
    [environmentIds],
  );
  return useQueries({
    queries: environmentIds.map((environmentId) =>
      sandboxAutomationQueryOptions(
        auth,
        userId,
        environmentId,
        signedIn && !unavailable && offered,
      ),
    ),
    combine,
  });
}
