/**
 * `EpicLaneUnaries` for a suite whose subject is not the lane unaries. Both members REJECT, and
 * that is the considered default rather than a convenience.
 */
import type { EpicLaneUnaries } from "../runtime/epic-replica-runtime";

export function absentLaneUnaries(): EpicLaneUnaries {
  return {
    getWorkspaceContext: () =>
      Promise.reject(
        new Error("this suite declared no epic.getWorkspaceContext transport"),
      ),
    retryMigration: () =>
      Promise.reject(
        new Error("this suite declared no epic.retryMigration transport"),
      ),
  };
}
