import {
  queryOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { GuiAgentModelOption } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { AuthService } from "@/lib/auth/auth-service";
import { useHostBinding } from "@/lib/host";
import { sandboxQueryKeys } from "@/lib/query-keys";
import { useAuthStore } from "@/stores/auth/auth-store";
import { sandboxFailureMessage } from "@/hooks/sandboxes/sandbox-failure-copy";
import { useSandboxControlUnavailableReason } from "@/hooks/sandboxes/use-sandbox-control-unavailable-reason";

/** The catalog moves on a server deploy, not on a user's action. */
const TRAYCER_MODELS_STALE_MS = 10 * 60_000;

function sandboxTraycerModelsQueryOptions(
  auth: AuthService | null,
  userId: string | null,
  enabled: boolean,
) {
  if (auth === null) {
    return queryOptions<ReadonlyArray<GuiAgentModelOption>>({
      queryKey: sandboxQueryKeys.traycerModelsMissing(),
      queryFn: () => Promise.reject(new Error("Sign in to choose a model.")),
      enabled: false,
    });
  }
  return queryOptions<ReadonlyArray<GuiAgentModelOption>>({
    queryKey: sandboxQueryKeys.traycerModels(auth, userId),
    queryFn: async () => {
      const result = await auth.getTraycerModels();
      if (result.kind === "ok") return result.models;
      throw new Error(sandboxFailureMessage(result));
    },
    enabled,
    staleTime: TRAYCER_MODELS_STALE_MS,
  });
}

/**
 * `GET /api/traycer/models`: the Traycer models every sandbox runs, from the
 * cloud rather than any host. A sandbox refusal's "Choose a model" lists
 * these, since the host the picker reads may have Traycer off and a resting
 * sandbox answers nothing.
 */
export function useSandboxTraycerModels(
  enabled: boolean,
): UseQueryResult<ReadonlyArray<GuiAgentModelOption>> {
  const binding = useHostBinding();
  const auth = binding === null ? null : binding.auth;
  const signedIn = useAuthStore((s) => s.status === "signed-in");
  const userId = useAuthStore((s) => s.contextMetadata?.userId ?? null);
  const unavailable = useSandboxControlUnavailableReason() !== null;
  return useQuery(
    sandboxTraycerModelsQueryOptions(
      auth,
      userId,
      signedIn && enabled && !unavailable,
    ),
  );
}
