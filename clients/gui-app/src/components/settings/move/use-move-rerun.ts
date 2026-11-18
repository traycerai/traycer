import { useState } from "react";
import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  EnvironmentSetupRetryRequest,
  EnvironmentSetupRetryResponse,
  EnvironmentStatusResponseV13,
} from "@traycer/protocol/host/environment-schemas";
import {
  useHostScopedMutationForClient,
  type HostScopedMutationContext,
} from "@/hooks/host/use-host-scoped-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";
import {
  MOVE_STOPPED_REASONS,
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
  /** The refusal shown before the Retry, again once its re-run stopped before asking. */
  readonly stoppedAgain: string | null;
  /** The move stopped: a stopped move refuses every plan until it runs again. */
  readonly stopped: boolean;
  readonly pending: boolean;
  readonly rerun: (refusal: string, started: () => void) => void;
}

interface Rerun {
  readonly attemptId: string;
  readonly refusal: string;
  readonly answeredAt: number;
}

/** What the move did after a Retry, by the first status reads that can say. */
type RerunReading = "waiting" | "asks" | "resumed" | "stopped_again";

/**
 * Only a read answered after the Retry's answer is the re-run's: the retry's
 * own invalidation drops a poll still out, and a read in hand before is the
 * stopped move's. The re-run starts from registering, which says nothing yet.
 * A recorded consent resumes under the stopped attempt's outcome (`retry`,
 * `running`); a move that will ask again has ended it first, so a consent wait
 * that still carries it is the resume passing through and asks nothing.
 */
function rerunReading(
  rerun: Rerun | null,
  status: EnvironmentStatusResponseV13 | null,
  readAt: number,
): RerunReading {
  if (rerun === null || status === null || readAt <= rerun.answeredAt)
    return "waiting";
  const setup = status.setup;
  if (setup === null) return "waiting";
  if (MOVE_STOPPED_REASONS[setup.state] !== undefined) return "stopped_again";
  if (setup.state === "done") return "resumed";
  const resuming =
    status.move?.state === "retry" || status.move?.state === "running";
  if (moveAwaitsConsent(status)) return resuming ? "waiting" : "asks";
  return setup.state === "running" &&
    (setup.stage === "moving_settings" || setup.stage === "applying")
    ? "resumed"
    : "waiting";
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
  const statusServed = useHostMethodSupport(hostId, "environment.status");
  const statusRead = useHostQuery<HostRpcRegistry, "environment.status">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.status",
    params: {},
    options: { enabled: statusServed === true, poll: true },
  });
  const status = statusRead.data ?? null;
  const retryable =
    useHostMethodSupport(hostId, "environment.setup.retry") === true;
  const retry = useMoveRetryMutation(client);
  const [rerun, setRerun] = useState<Rerun | null>(null);
  const reading = rerunReading(rerun, status, statusRead.dataUpdatedAt);
  return {
    planKey: rerun === null ? undefined : [rerun.attemptId],
    planReadable: rerun === null || reading === "asks",
    resumed: reading === "resumed",
    stoppedAgain:
      rerun !== null && reading === "stopped_again" ? rerun.refusal : null,
    stopped: retryable && status !== null && moveHasStopped(status),
    pending: retry.isPending,
    rerun: (refusal, started) => {
      retry.mutate(
        {},
        {
          onSuccess: (answer) => {
            started();
            setRerun({
              attemptId: answer.attemptId,
              refusal,
              answeredAt: Date.now(),
            });
          },
        },
      );
    },
  };
}
