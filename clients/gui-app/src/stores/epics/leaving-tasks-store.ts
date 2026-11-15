import { create } from "zustand";

/**
 * Tasks this window is leaving because the host refused them, or because
 * another window owns their tab, while the navigation away waits for a router
 * load in flight (`runWhenRouterSettled`). The task's route draws nothing and
 * makes no recency decision for them in that time, so nothing of a refused
 * task is drawn or written after the refusal.
 */
interface LeavingTasksState {
  readonly epicIds: ReadonlySet<string>;
}

export const useLeavingTasksStore = create<LeavingTasksState>()(() => ({
  epicIds: new Set<string>(),
}));

/** Marks `epicId` as being left; answers the unmark, safe to call twice. */
export function markLeavingTask(epicId: string): () => void {
  useLeavingTasksStore.setState((state) => ({
    epicIds: new Set(state.epicIds).add(epicId),
  }));
  let marked = true;
  return () => {
    if (!marked) return;
    marked = false;
    useLeavingTasksStore.setState((state) => {
      const epicIds = new Set(state.epicIds);
      epicIds.delete(epicId);
      return { epicIds };
    });
  };
}
