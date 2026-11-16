import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { EnvironmentCloud } from "@traycer-clients/shared/environment/environment-cloud";
import { usePressCapturedMutation } from "@/hooks/use-press-captured-mutation";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  invalidateEnvironmentReads,
  useEnvironmentCloud,
} from "@/hooks/environment/use-environment-cloud";
import { hostClientUnavailableError } from "@/hooks/host/use-host-query";
import { environmentCloudHostError } from "@/lib/environment/environment-cloud-calls";
import {
  runEnvironmentMove,
  type EnvironmentMoveAcceptance,
  type EnvironmentMoveResult,
} from "@traycer-clients/shared/environment/environment-move-flow";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { toastFromHostError } from "@/lib/host-error-toast";
import { withHostQueryErrorBoundary } from "@/lib/query/host-query-error-boundary";
import { environmentMutationKeys } from "@/lib/query-keys";

const METHOD = "environment.move.start";

/** What a move or a give changes: where the computer stands, and its plan. */
const MOVE_READS = ["environment.status", "environment.move.plan"] as const;

interface PressedMove {
  readonly operation: EnvironmentCloud | null;
  readonly client: HostClient<HostRpcRegistry> | null;
}

/**
 * The click on a move or a give, on the computer `client` reaches: it stages
 * what the person accepted, records the acceptance at authn on their sign-in,
 * and hands the computer that acceptance (`runEnvironmentMove`). A failure
 * toasts `errorMessage`; `null` leaves it to the surface's own inline line.
 */
export function useEnvironmentMoveStartMutation(
  client: HostClient<HostRpcRegistry> | null,
  errorMessage: string | null,
): UseMutationResult<
  EnvironmentMoveResult,
  HostRpcError,
  EnvironmentMoveAcceptance
> {
  const queryClient = useQueryClient();
  const cloud = useEnvironmentCloud();
  return usePressCapturedMutation<
    EnvironmentMoveResult,
    HostRpcError,
    EnvironmentMoveAcceptance,
    PressedMove
  >(
    () => ({ operation: cloud === null ? null : cloud(), client }),
    {
      mutationKey: environmentMutationKeys.moveStart(),
      mutationFn: (accepted, pressed) =>
        withHostQueryErrorBoundary(METHOD, async () => {
          const { operation, client: pressedClient } = pressed;
          cloudVerdictPreflight(METHOD)();
          if (pressedClient === null || operation === null)
            throw hostClientUnavailableError(METHOD);
          if (!operation.onOriginSignIn()) return { kind: "sign_in_changed" } as const;
          try {
            return await runEnvironmentMove(
              {
                stage: (request) =>
                  pressedClient.request("environment.move.stage", request),
                start: (request) =>
                  pressedClient.request("environment.move.start", request),
              },
              operation,
              accepted,
            );
          } catch (error) {
            throw environmentCloudHostError(METHOD, error);
          }
        }),
      onSettled: () => {
        void invalidateEnvironmentReads(queryClient, MOVE_READS);
      },
      onError: (error) => {
        if (errorMessage !== null) toastFromHostError(error, errorMessage);
      },
    },
  );
}
