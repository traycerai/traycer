import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  AutoJudgeGetResponse,
  AutoJudgeSetRequest,
  AutoJudgeSetResponse,
} from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  autoJudgeWriteScope,
  autoModeMutationKeys,
  hostQueryKeys,
} from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

type SetAutoJudgeContext = {
  readonly hostId: string | null;
};

/**
 * Writes this host's judge selection.
 *
 * The read is updated in place from the response, and THEN revalidated. The
 * in-place write is for the `selection`: Settings ▸ Permissions ▸ Judge
 * commits on every provider / account / model choice, and without it the
 * controls would snap back to the previous selection for the frame before a
 * refetch lands. The response settles that question - it echoes what the host
 * persisted.
 *
 * It does not settle `effective` and `blocked`. Those are the host's verdict
 * on availability - provider enablement, the Traycer row, the Traycer model
 * read (`readAutomaticJudge`) - taken at one moment DURING the save, after the
 * write and before the reply. Anything that moves in between has already
 * asked for this read to be refreshed: the harness catalog's
 * `invalidateAutoJudgeOnAutomaticInputs`, a provider mutation's
 * `PROVIDER_INVALIDATIONS`. That refresh can even have landed first, and an
 * echo written on top of it, marked fresh, would undo it until the next
 * transition - the composer would name Traycer's credits for a run that falls
 * back to the provider. So the echo is written as a placeholder and the read
 * is invalidated straight after: the composer withholds the verdict until the
 * re-read lands (`useAutoJudgeBilling`), and Settings shows the echo until
 * then. The re-read is asked after the save, so it can only be newer.
 *
 * This is revalidation rather than a fence on an availability generation
 * because the verdict has more than one input and each has its own
 * invalidator; a fence would need every one of them to bump the same
 * counter, and a revalidation needs none. Not awaited: the save is done, and
 * the pick it settles should not wait on a read.
 *
 * `hostId` is captured in `onMutate` so a surface whose host moved mid-flight
 * files the answer against the host that was asked.
 *
 * That in-place write is exactly why the ORDER matters and why this hook takes
 * `autoJudgeWriteScope`: the coordinator's `fifo` queue key carries the params,
 * so two clicks naming two different judges sit in two queues and race, and the
 * cache would then hold whichever response landed last rather than the judge
 * the user picked last. See the scope's own note.
 */
export function useAutoJudgeSetMutation(): UseMutationResult<
  AutoJudgeSetResponse,
  HostRpcError,
  AutoJudgeSetRequest,
  SetAutoJudgeContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "autoJudge.set", SetAutoJudgeContext>(
    {
      client,
      method: "autoJudge.set",
      mapVariables: (variables) => variables,
      options: {
        mutationKey: autoModeMutationKeys.setJudge(),
        scope: autoJudgeWriteScope(client.getActiveHostId() ?? null),
        onMutate: () => ({ hostId: client.getActiveHostId() ?? null }),
        // CANCEL, then write, then revalidate (the hook's note says why the
        // last). The written selection is only authoritative if no older read
        // can land on top of it, and one routinely can: the row
        // sets `refetchOnMount: "always"`, so a read started before the save -
        // by a remount, a recovery sweep, or the poll table - is still in
        // flight when the response arrives, and TanStack resolves it into the
        // same cache entry afterwards. Measured on the real QueryClient:
        // `afterSave={SAVED}; afterRead={OLD}`.
        //
        // `await`ed, which keeps the mutation pending across it - and that is
        // what makes the Judge tab's hand-off seamless. Nothing is disabled
        // while a write is in flight: the tab presents its latest pick, not
        // the record, until THAT pick's per-call callback settles, and
        // TanStack runs per-call callbacks only after this `onSuccess` has
        // resolved, so the cache already holds the saved selection when the
        // pick gives way to it. A second pick made meanwhile queues behind this
        // write on `autoJudgeWriteScope`.
        onSuccess: async (data, _variables, ctx) => {
          if (ctx.hostId === null) return;
          const queryKey = hostQueryKeys.methodScope(
            ctx.hostId,
            "autoJudge.get",
          );
          await queryClient.cancelQueries({ queryKey });
          queryClient.setQueriesData<AutoJudgeGetResponse>({ queryKey }, data);
          // In the same tick as the write, so no render sees the echo's
          // verdict as fresh.
          void queryClient.invalidateQueries({ queryKey });
        },
        onError: (error) =>
          toastFromHostError(error, "Couldn't save the Auto mode judge."),
      },
    },
  );
}
