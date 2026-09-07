/** The handlers a spawner needs, for a store that does not exist yet. */
import type { RuntimeProjectionHandlers } from "@traycer-clients/shared/replica-runtime/worker/runtime-projection-subscription";

export interface LateBoundProjectionTarget<TProjection> {
  /** Hand to the spawner. Safe to call before {@link attach}. */
  readonly handlers: RuntimeProjectionHandlers<TProjection>;
  /** Point the slot at the real handlers and replay whatever arrived first. */
  attach(target: RuntimeProjectionHandlers<TProjection>): void;
}

export function createLateBoundProjectionTarget<TProjection>(
  /** The payload check, which is the CALLER's because the slice's shape is the store's. */
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
        // A fault report, so it survives the gap too - logged rather than queued, because replaying a
        // rejection tells the store about a publication it never had.
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
