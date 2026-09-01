/**
 * `EpicLaneUnaries` for a suite whose subject is not the lane unaries.
 *
 * Both members REJECT, and that is the considered default rather than a
 * convenience. The alternative - resolving `getWorkspaceContext` with an empty
 * context - would be projected into `snapshotMeta` as authoritative, so a suite
 * that never meant to exercise the read would assert against invented repos,
 * folders and a permission role. A rejection is what the refresh policy already
 * handles (log, retry on the next trigger) and it establishes nothing.
 *
 * A suite that IS about these reads supplies its own; there is deliberately no
 * "resolve with this" parameter here, because a helper that could be made to
 * answer is a helper that gets used instead of the real seam.
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
