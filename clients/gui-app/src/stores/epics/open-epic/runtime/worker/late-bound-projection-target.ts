/**
 * The handlers a spawner needs, for a store that does not exist yet.
 *
 * The worker is spawned BEFORE the store: the store needs the port the spawner
 * hands back, and the spawner needs the handlers only the store can supply.
 * Both wirings resolve that the same way - spawn, construct, then attach the
 * store's handlers to a slot.
 *
 * **What that slot used to do with traffic in the gap was lose it.** The
 * handler was `accept: (value) => target?.accept(value) ?? null`, and
 * `createRuntimeProjectionOrdering` reads a `null` from `accept` as
 * `reject("unrecognised")` - a FOREIGN PAYLOAD. So a publication made while
 * the slot was empty was discarded and reported as garbage.
 *
 * The gap is not theoretical and not brief: the worker composes and calls
 * `runtime.start()` INSIDE the spawn, over a synchronous pipe. Every slice
 * published at composition landed in it. `installedArm` is one - published
 * when the arm installs and never again, because the sink publishes only
 * changed keys - so it read `null` for the life of the session, and
 * `getArtifactBodyDocKey` keys bodies by the wrong id on the `@1` arm.
 *
 * Two things fix it, and the second is the mechanism rather than a tidy-up:
 *
 *  1. **Buffer at `apply`.** Publications made before the attach are queued in
 *     arrival order - the ordering layer has already sequenced them - and
 *     replayed on attach.
 *  2. **`accept` stops depending on the target.** The store's `accept` is a
 *     pure parser (`isProjectionPatch(value) ? value : null`, no store state),
 *     so it moves in here directly. After that a `null` from `accept` means
 *     "foreign payload" and NOTHING else - the two answers that were conflated
 *     are now separated by construction instead of by convention.
 *
 * ONE helper with two users, deliberately: the provider and the test harness
 * held identical inline copies of the broken shape, which is exactly how the
 * two drift.
 */
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";

export interface LateBoundProjectionTarget<TProjection> {
  /** Hand to the spawner. Safe to call before {@link attach}. */
  readonly handlers: RuntimeProjectionHandlers<TProjection>;
  /**
   * Point the slot at the real handlers and replay whatever arrived first.
   *
   * Replay happens BEFORE any later publication can be delivered, because both
   * run on the same thread and this is synchronous - so the store never sees a
   * newer slice ahead of an older one.
   */
  attach(target: RuntimeProjectionHandlers<TProjection>): void;
}

export function createLateBoundProjectionTarget<TProjection>(
  /**
   * The payload check, which is the CALLER's because the slice's shape is the
   * store's. Taken as a pure function rather than read off the target: that is
   * what lets `accept` answer honestly while the slot is still empty.
   */
  parse: (value: unknown) => TProjection | null,
  /** Where a pre-attach fault report goes. Never dropped silently. */
  reportEarlyRejection: (reason: string, revision: number) => void,
): LateBoundProjectionTarget<TProjection> {
  let target: RuntimeProjectionHandlers<TProjection> | null = null;
  const pending: { value: TProjection; revision: number }[] = [];

  return {
    handlers: {
      // Target-INDEPENDENT. A `null` from here now means one thing only.
      accept: (value) => parse(value),
      apply: (value, revision) => {
        if (target === null) {
          pending.push({ value, revision });
          return;
        }
        target.apply(value, revision);
      },
      reject: (reason, revision) => {
        // A fault report, so it survives the gap too - logged rather than
        // queued, because replaying a rejection tells the store about a
        // publication it never had.
        if (target === null) {
          reportEarlyRejection(reason, revision);
          return;
        }
        target.reject(reason, revision);
      },
    },
    attach(next): void {
      target = next;
      // Drained through the SAME `apply` the live path uses, in arrival order.
      // Cleared as it drains so a re-attach cannot replay twice.
      while (pending.length > 0) {
        const held = pending.shift();
        if (held === undefined) break;
        next.apply(held.value, held.revision);
      }
    },
  };
}
