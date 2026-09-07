import {
  useIsMutating,
  useMutation,
  useMutationState,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  HostRpcError,
  withHostRpcErrorBoundary,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  managedCommandControlResponseSchema,
  type ManagedCommand,
  type ManagedCommandHeldReleaseFailure,
  type ManagedCommandHeldReleaseUnattributed,
} from "@traycer/protocol/host/managed-command/unary-schemas";
import {
  useHostClient,
  useHostDirectory,
  type HostRpcRegistry,
} from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import {
  hostClientUnavailableError,
  withHostMutationLifecycleBoundary,
} from "@/hooks/host/use-host-query";
import { managedCommandMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/** Pin to the command's own host. No create/edit. List stream is the success path; do not invalidate. */
export interface ManagedCommandLifecycleVariables {
  readonly hostId: string;
  readonly epicId: string;
  readonly commandId: string;
}

type LifecycleMethod =
  | "managedCommand.start"
  | "managedCommand.stop"
  | "managedCommand.delete";

/** Plain function for mutationFn. Missing or undialable entry is null (hostClientUnavailableError). */
function transientClientForEntry(
  defaultClient: HostClient<HostRpcRegistry>,
  entry: HostDirectoryEntry | null,
): HostClient<HostRpcRegistry> | null {
  return entry === null ? null : buildDialableHostClient(defaultClient, entry);
}

function useManagedCommandLifecycleMutation<Method extends LifecycleMethod>(
  method: Method,
  mutationKey: readonly string[],
  errorMessage: string,
  // The three methods share a request shape but not a type: `client.request`
  // resolves its argument from the literal method, so each caller passes the
  // concrete call rather than widening it here.
  send: (
    client: HostClient<HostRpcRegistry>,
    variables: ManagedCommandLifecycleVariables,
  ) => Promise<ResponseOfMethod<HostRpcRegistry, Method>>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary(method, {
      mutationKey,
      mutationFn: (variables: ManagedCommandLifecycleVariables) =>
        withHostRpcErrorBoundary(method, () => {
          const client = transientClientForEntry(
            defaultClient,
            directory.findById(variables.hostId),
          );
          if (client === null) {
            return Promise.reject(hostClientUnavailableError(method));
          }
          return send(client, variables);
        }),
      onError: (error: HostRpcError) => toastFromHostError(error, errorMessage),
    }),
  );
}

export function useManagedCommandStart(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.start">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.start",
    managedCommandMutationKeys.start(),
    "Couldn't start it.",
    (client, variables) =>
      client.request("managedCommand.start", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}

export function useManagedCommandStop(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.stop">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.stop",
    managedCommandMutationKeys.stop(),
    "Couldn't stop it.",
    (client, variables) =>
      client.request("managedCommand.stop", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}

export interface ManagedCommandStopAllVariables {
  readonly hostId: string;
  readonly epicId: string;
  readonly commandIds: readonly string[];
}

/** A mutation result's own `isPending` is per-observer, and the same chat can be open in two canvas tiles - a second tile's button must go dead the moment the first tile's batch starts, or it re-submits the same command ids. */
export function useManagedCommandStopAllIsPending(chatId: string): boolean {
  return (
    useIsMutating({ mutationKey: managedCommandMutationKeys.stopAll(chatId) }) >
    0
  );
}

/** Stop the set as one action; one toast, one pending flag. Do not fan out per-row stops. */
export function useManagedCommandStopAll(
  chatId: string,
): UseMutationResult<void, Error, ManagedCommandStopAllVariables> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation<void, Error, ManagedCommandStopAllVariables>({
    mutationKey: managedCommandMutationKeys.stopAll(chatId),
    mutationFn: async (variables) => {
      const entry = directory.findById(variables.hostId);
      const client: HostClient<HostRpcRegistry> | null =
        entry === null ? null : buildDialableHostClient(defaultClient, entry);
      // No host client means every stop would fail identically, so fail once
      // with the real reason instead of manufacturing N rejections that
      // collapse into an uninformative "couldn't stop N of N" count.
      if (client === null) {
        throw hostClientUnavailableError("managedCommand.stop");
      }
      const outcomes = await Promise.allSettled(
        variables.commandIds.map((commandId) =>
          withHostRpcErrorBoundary("managedCommand.stop", () =>
            client.request("managedCommand.stop", {
              epicId: variables.epicId,
              commandId,
            }),
          ),
        ),
      );
      const rejections = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      if (rejections.length === 0) return;
      // A batch that failed WHOLESALE almost always failed for one systemic reason (revoked access, host gone, method unsupported).
      const representative: unknown = rejections[0].reason;
      if (
        rejections.length === outcomes.length &&
        representative instanceof HostRpcError
      ) {
        throw representative;
      }
      throw new Error(
        `Couldn't stop ${rejections.length} of ${outcomes.length} shells.`,
      );
    },
    onError: (error) => {
      if (error instanceof HostRpcError) {
        toastFromHostError(error, "Couldn't stop them.");
        return;
      }
      toast.error(error.message);
    },
  });
}

export interface ManagedCommandConfigureVariables extends ManagedCommandLifecycleVariables {
  readonly relaunchOnHostRestart: boolean;
}

export interface ManagedCommandConfigureTarget {
  readonly hostId: string;
  readonly commandId: string;
}

export function managedCommandConfigureScopeId(
  target: ManagedCommandConfigureTarget,
): string {
  return JSON.stringify([
    "managedCommand.configure",
    target.hostId,
    target.commandId,
  ]);
}

/** A mutation result's `isPending` is per-observer, and the same command is rendered in the list row and the output window header at once: with only the pressing surface disabled, the other still shows the OLD streamed value and a press there computes the same inverse again - two identical writes, not the on-then-off the person meant. */
export function useManagedCommandConfigureIsPending(
  target: ManagedCommandConfigureTarget,
): boolean {
  return (
    useIsMutating({
      mutationKey: managedCommandMutationKeys.configure(
        target.hostId,
        target.commandId,
      ),
    }) > 0
  );
}

/** Prefer a newer configure mutation cache over the stream until updatedAtMs advances. */
export function useManagedCommandRelaunchOnHostRestart(
  target: ManagedCommandConfigureTarget,
  streamed: ManagedCommand,
): boolean {
  const settled = useMutationState({
    filters: {
      mutationKey: managedCommandMutationKeys.configure(
        target.hostId,
        target.commandId,
      ),
      status: "success",
    },
    select: (mutation) => ({
      data: mutation.state.data,
      // Monotonic per mutation cache, assigned at `mutate()`: press order.
      // Not `submittedAt` - two presses in one millisecond stamp the same
      // clock value, which is exactly the collision this has to break.
      order: mutation.mutationId,
    }),
  });
  // Without the tie-break the first of an on-then-off pair would keep winning.
  let newest: { command: ManagedCommand; order: number } | null = null;
  for (const entry of settled) {
    const parsed = managedCommandControlResponseSchema.safeParse(entry.data);
    if (!parsed.success) continue;
    const candidate = { command: parsed.data.command, order: entry.order };
    if (
      newest === null ||
      candidate.command.updatedAtMs > newest.command.updatedAtMs ||
      (candidate.command.updatedAtMs === newest.command.updatedAtMs &&
        candidate.order > newest.order)
    ) {
      newest = candidate;
    }
  }
  // The stream wins on EQUAL stamps too.
  if (newest === null || newest.command.updatedAtMs <= streamed.updatedAtMs) {
    return streamed.relaunchOnHostRestart;
  }
  return newest.command.relaunchOnHostRestart;
}

/** Serialize configure writes by (hostId, commandId). fifo lanes keyed on params would reorder on/off. */
export function useManagedCommandConfigure(
  target: ManagedCommandConfigureTarget,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.configure">,
  HostRpcError,
  ManagedCommandConfigureVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary("managedCommand.configure", {
      mutationKey: managedCommandMutationKeys.configure(
        target.hostId,
        target.commandId,
      ),
      scope: { id: managedCommandConfigureScopeId(target) },
      mutationFn: (variables: ManagedCommandConfigureVariables) =>
        withHostRpcErrorBoundary("managedCommand.configure", () => {
          const client = transientClientForEntry(
            defaultClient,
            directory.findById(variables.hostId),
          );
          if (client === null) {
            return Promise.reject(
              hostClientUnavailableError("managedCommand.configure"),
            );
          }
          return client.request("managedCommand.configure", {
            epicId: variables.epicId,
            commandId: variables.commandId,
            relaunchOnHostRestart: variables.relaunchOnHostRestart,
          });
        }),
      onError: (error: HostRpcError) =>
        toastFromHostError(error, "Couldn't change it."),
    }),
  );
}

export function useManagedCommandDelete(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.delete">,
  HostRpcError,
  ManagedCommandLifecycleVariables
> {
  return useManagedCommandLifecycleMutation(
    "managedCommand.delete",
    managedCommandMutationKeys.delete(),
    "Couldn't delete it.",
    (client, variables) =>
      client.request("managedCommand.delete", {
        epicId: variables.epicId,
        commandId: variables.commandId,
      }),
  );
}

/** Read unattributed first: empty held/released then means undetermined, not empty. Render the host message verbatim. */
function reportDeliverHeldOutcome(
  response: ResponseOfMethod<HostRpcRegistry, "managedCommand.deliverHeld">,
): void {
  if (response.unattributed.length > 0) {
    reportUnattributedDeliverFailure(response.unattributed);
    return;
  }
  if (response.unresolved.length === 0) return;
  reportUnresolvedDeliverHolds(response.unresolved);
}

/** Never phrased as a count of shells: one of these is produced whether the chat holds one shell or four, so any number here would be a number of internal proof arms rather than of anything a person can see. */
function reportUnattributedDeliverFailure(
  failures: readonly ManagedCommandHeldReleaseUnattributed[],
): void {
  const detail =
    failures.length === 1 ? { description: failures[0].message } : undefined;
  if (failures.every((failure) => !failure.retryable)) {
    toast.error(
      "Nothing was delivered — this host can't tell what it's holding for this chat.",
      detail,
    );
    return;
  }
  toast.warning("Nothing was delivered. Try again in a moment.", detail);
}

/** Try again in a moment.", which told a person to retry the very shells where retrying can never work; it reports the split instead. */
function reportUnresolvedDeliverHolds(
  failures: readonly ManagedCommandHeldReleaseFailure[],
): void {
  const permanent = failures.filter((failure) => !failure.retryable);
  const retryable = failures.filter((failure) => failure.retryable);
  if (retryable.length === 0) {
    toast.error(
      permanent.length === 1
        ? "That shell's output can't be delivered by this host."
        : `${permanent.length} shells' output can't be delivered by this host.`,
      permanent.length === 1
        ? { description: permanent[0].message }
        : undefined,
    );
    return;
  }
  if (permanent.length === 0) {
    toast.warning(
      retryable.length === 1
        ? "One shell is still held. Try again in a moment."
        : `${retryable.length} shells are still held. Try again in a moment.`,
      retryable.length === 1
        ? { description: retryable[0].message }
        : undefined,
    );
    return;
  }
  // Mixed: the two halves have different remedies and no single `message`
  // stands for both, so the count is the honest report and it is reported per
  // half rather than summed under the retryable half's advice.
  toast.warning(
    `${failures.length} shells are still held: ${retryable.length} can be delivered on a retry, ${permanent.length} can't be delivered by this host.`,
  );
}

export interface ManagedCommandDeliverHeldVariables {
  readonly hostId: string;
  readonly epicId: string;
  readonly chatId: string;
  /** Null releases every hold this chat owns. */
  readonly commandIds: readonly string[] | null;
}

/** Whether a Deliver is in flight for this chat, across every mounted panel - the same shared-pending read `Stop all` needs, and for a stronger reason: a null-ids Deliver names no commands, so a second tile re-sending it is not a duplicate of a narrower request but the identical whole-chat action. */
export function useManagedCommandDeliverHeldIsPending(chatId: string): boolean {
  return (
    useIsMutating({
      mutationKey: managedCommandMutationKeys.deliverHeld(chatId),
    }) > 0
  );
}

/** Pin to the command's own host. Partial failure is a resolved response with unresolved, not a rejection. */
export function useManagedCommandDeliverHeld(
  chatId: string,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "managedCommand.deliverHeld">,
  HostRpcError,
  ManagedCommandDeliverHeldVariables
> {
  const defaultClient = useHostClient();
  const directory = useHostDirectory();

  return useMutation(
    withHostMutationLifecycleBoundary("managedCommand.deliverHeld", {
      mutationKey: managedCommandMutationKeys.deliverHeld(chatId),
      mutationFn: (variables: ManagedCommandDeliverHeldVariables) =>
        withHostRpcErrorBoundary("managedCommand.deliverHeld", () => {
          const client = transientClientForEntry(
            defaultClient,
            directory.findById(variables.hostId),
          );
          if (client === null) {
            return Promise.reject(
              hostClientUnavailableError("managedCommand.deliverHeld"),
            );
          }
          return client.request("managedCommand.deliverHeld", {
            epicId: variables.epicId,
            chatId: variables.chatId,
            commandIds:
              variables.commandIds === null ? null : [...variables.commandIds],
          });
        }),
      onSuccess: reportDeliverHeldOutcome,
      onError: (error: HostRpcError) =>
        toastFromHostError(error, "Couldn't deliver it."),
    }),
  );
}
