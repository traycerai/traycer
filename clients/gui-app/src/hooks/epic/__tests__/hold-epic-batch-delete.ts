import type { QueryClient } from "@tanstack/react-query";
import type { BatchDeleteEpicVariables } from "@/hooks/epic/use-epic-batch-delete-mutation";
import { epicMutationKeys } from "@/lib/query-keys";

export interface HeldEpicBatchDelete {
  /** Lets the held `epic.batchDelete` resolve, so its mutation settles. */
  readonly settle: () => Promise<void>;
}

/**
 * Puts one `epic.batchDelete` dispatch in flight on `queryClient` and holds it
 * there until `settle()` is called.
 *
 * The readers a list row or an open gate asks ("is this task being deleted?")
 * answer from the mutation cache by `epicMutationKeys.batchDelete()`, never off
 * one hook instance, so a held entry under that key with the dispatch's own
 * variables shape is exactly what a real confirmed delete leaves behind. This
 * is the host client whose `epic.batchDelete` promise is held, minus the host:
 * suites that mock `useEpicBatchDelete` wholesale (the list panels, which have
 * no host runtime to mount) keep the REAL readers and drive them with this.
 */
export function holdEpicBatchDelete(
  queryClient: QueryClient,
  ids: ReadonlyArray<string>,
): HeldEpicBatchDelete {
  let release: () => void = () => {
    throw new Error("the held delete was never started");
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const variables: BatchDeleteEpicVariables = { ids, worktreeCleanup: null };
  const mutation = queryClient
    .getMutationCache()
    .build<void, Error, BatchDeleteEpicVariables, unknown>(queryClient, {
      mutationKey: epicMutationKeys.batchDelete(),
      mutationFn: () => held,
    });
  const running = mutation.execute(variables);
  return {
    settle: async () => {
      release();
      await running;
    },
  };
}
