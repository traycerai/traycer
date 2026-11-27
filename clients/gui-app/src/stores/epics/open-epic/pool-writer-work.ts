import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { createSelector } from "reselect";

export function hasPoolDocumentWork(
  state: Pick<OpenEpicState, "isDirty" | "unsyncedQueueSize">,
): boolean {
  return state.isDirty || state.unsyncedQueueSize > 0;
}

export const selectPoolCommentOutcomes = createSelector(
  (state: OpenEpicState) => state.poolCommentWrites,
  (writes) => {
    let pending = false;
    let unknown = false;
    for (const write of writes.values()) {
      if (write === "pending") pending = true;
      else unknown = true;
    }
    return { pending, unknown };
  },
);
