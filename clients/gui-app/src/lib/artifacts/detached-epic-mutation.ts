import { appLogger } from "@/lib/logger";

/**
 * Terminal handler for an epic mutation chain a surface deliberately detaches.
 *
 * `void` states the intent not to await; it does NOT consume a rejection. Three
 * separate things reject on these paths and none of them is covered by the
 * `void` alone:
 *
 *  - The SETUP call. `beginRenameMutation`, `renameArtifact`, `deleteArtifact`
 *    and friends run through the runtime worker bridge, which answers `null`
 *    only for a disposed bridge and RETHROWS a worker-handler fault or a
 *    malformed bridge response - exactly so a real failure is not mistaken for
 *    a closed session.
 *  - The SETTLEMENT arms. A two-arm `.then(landed, failed)` does not catch what
 *    `landed` or `failed` themselves throw, and both call
 *    `retirePendingMutation` - another bridge round trip. `failed` covers the
 *    RPC's rejection, never its own.
 *  - The RETIRE-only arm, for a kind with no RPC to ack it.
 *
 * Shared rather than per-file because it was per-file: this handler existed in
 * `use-rename-canvas-tab.ts` alone while the mobile switcher and the sidebar
 * tree ran the same three shapes unguarded - which is how one round's fix left
 * five siblings for the next round to find. One helper means the next surface
 * that detaches a mutation inherits the answer instead of re-deriving it.
 *
 * A LOG, not a toast: these are the paths whose user-visible outcome is already
 * decided elsewhere (an optimistic overlay that rolls back, a projection that
 * never changes). What was missing is that the failure left no trace at all.
 */
export function settleDetachedEpicMutation(
  work: Promise<unknown>,
  surface: string,
  stage: string,
): void {
  void work.catch((error: unknown) => {
    appLogger.warn("detached epic mutation failed", {
      surface,
      stage,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
