import { useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentSetupRetryRequest,
  EnvironmentSetupRetryResponse,
} from "@traycer/protocol/host/environment-schemas";
import { useEnvironmentStatusRead } from "@/hooks/environment/use-environment-reads";
import {
  useHostScopedMutationForClient,
  type HostScopedMutationContext,
} from "@/hooks/host/use-host-scoped-mutation";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import {
  moveAwaitsConsent,
  moveHasStopped,
} from "@/lib/environment/move-in-progress";
import { environmentMutationKeys } from "@/lib/query-keys";

/** Starts a stopped move again (`environment.setup.retry`), which applies nothing twice. */
export function useMoveRetryMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  EnvironmentSetupRetryResponse,
  HostRpcError,
  EnvironmentSetupRetryRequest,
  HostScopedMutationContext<undefined>
> {
  return useHostScopedMutationForClient(client, {
    method: "environment.setup.retry",
    mutationKey: environmentMutationKeys.setupRetry(),
    errorMessage: "Couldn't retry the move.",
    invalidateMethods: ["environment.status", "environment.setup.attempts"],
  });
}

export interface MoveRerun {
  /** The plan read's own key once a Retry has run the move again. */
  readonly planKey: readonly unknown[] | undefined;
  /** False from a Retry until the move it started waits for the person again. */
  readonly planReadable: boolean;
  /** A Retry's re-run went on with the accepted move instead of asking again. */
  readonly resumed: boolean;
  /** The move stopped: a stopped move refuses every plan until it runs again. */
  readonly stopped: boolean;
  readonly pending: boolean;
  readonly rerun: (started: () => void) => void;
}

/**
 * A stopped move's Retry for the move sheet. The plan it asks afterwards is a
 * new read, made only once the move waits for the person again, so nothing
 * read before the Retry is asked.
 */
export function useMoveRerun(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string,
): MoveRerun {
  const status = useEnvironmentStatusRead(client, hostId, true);
  const retryable =
    useHostMethodSupport(hostId, "environment.setup.retry") === true;
  const retry = useMoveRetryMutation(client);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  return {
    planKey: attemptId === null ? undefined : [attemptId],
    planReadable:
      attemptId === null ||
      (status.data !== null && moveAwaitsConsent(status.data)),
    // Asked only of a stopped move, so any read after it that neither waits
    // for the person nor has stopped is the move going on, or already done.
    resumed:
      attemptId !== null &&
      status.data !== null &&
      !moveAwaitsConsent(status.data) &&
      !moveHasStopped(status.data),
    stopped: retryable && status.data !== null && moveHasStopped(status.data),
    pending: retry.isPending,
    rerun: (started) => {
      retry.mutate(
        {},
        {
          onSuccess: (answer) => {
            started();
            setAttemptId(answer.attemptId);
          },
        },
      );
    },
  };
}
