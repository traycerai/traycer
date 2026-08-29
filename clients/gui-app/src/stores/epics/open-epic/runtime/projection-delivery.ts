/**
 * Where the runtime's three sinks actually land, and how a frame that touches
 * more than one plane still costs ONE store write.
 *
 * The shared sink deliberately stops at "publish a whole projection". Batching,
 * subscription and re-render skipping are the consumer's, and this file is that
 * consumer half: a delivery the planes publish into, and a batch window the
 * runtime opens around anything that can move several planes at once.
 *
 * ## Why the batch window is not optional
 *
 * The block this replaces wrote one `set(...)` per wire frame, folding record
 * slices, projected slices, dirty state and connection legs into a single
 * object. Zustand notifies every subscriber on every `set`, and each
 * notification re-runs the selector of every mounted `useStore` consumer - so
 * splitting one frame into three writes is three full notification rounds over
 * an epic's entire component tree. Selectors would still skip the renders, but
 * the rounds are not free and the render-count characterisation pins them.
 *
 * The window is therefore a behaviour requirement, not a tidiness one.
 */
import type {
  ProjectionDelivery,
  ProjectionSink,
} from "@traycer-clients/shared/replica-runtime";
import type { EpicProjectedSlices } from "../types";
import type {
  EpicRecordsProjection,
  EpicRuntimeProjection,
} from "./epic-runtime-projection";

export interface EpicRuntimeDelivery {
  /** Publish one plane's projection. Coalesced while a batch is open. */
  publish(patch: Partial<EpicRuntimeProjection>): void;
  /**
   * Run `body`, coalescing every publish it produces into one commit.
   *
   * Re-entrant: only the outermost window commits, so a plane that batches
   * internally composes with a runtime-level frame instead of fighting it. A
   * window in which nothing published commits nothing.
   */
  batch(body: () => void): void;
}

/**
 * @param commit Applies one merged patch to whatever holds the read model -
 * `store.setState` today, a `postMessage` once the runtime is in a worker.
 */
export function createBatchingDelivery(
  commit: (patch: Partial<EpicRuntimeProjection>) => void,
): EpicRuntimeDelivery {
  let depth = 0;
  let pending: Partial<EpicRuntimeProjection> | null = null;

  function flush(): void {
    if (pending === null) return;
    const patch = pending;
    // Cleared BEFORE the commit, not after: a subscriber woken by the commit
    // can publish again synchronously (the auth bridge's republish does), and
    // clearing afterwards would drop that second patch on the floor.
    pending = null;
    commit(patch);
  }

  return {
    publish(patch: Partial<EpicRuntimeProjection>): void {
      if (depth === 0) {
        commit(patch);
        return;
      }
      pending = pending === null ? { ...patch } : Object.assign(pending, patch);
    },
    batch(body: () => void): void {
      depth += 1;
      try {
        body();
      } finally {
        depth -= 1;
        // Commits even when `body` threw: a partially applied frame is still
        // the runtime's current state, and withholding it would leave the UI
        // rendering something the replicas no longer hold.
        if (depth === 0) flush();
      }
    },
  };
}

/**
 * Adapt a plane's delivery into the shared sink's {@link ProjectionDelivery}.
 *
 * The revision is dropped on purpose. Consumers key "has anything changed at
 * all" on the sink's own `revision()`, and re-publishing it into the store
 * would put a second, weaker copy of that counter in the read model - one that
 * would then need its own change gate to avoid re-rendering the tree on every
 * no-op frame.
 */
export function deliverInto<TProjection extends Partial<EpicRuntimeProjection>>(
  delivery: EpicRuntimeDelivery,
): ProjectionDelivery<TProjection> {
  return (value: TProjection): void => {
    delivery.publish(value);
  };
}

/**
 * A narrowing view of the records sink for the projector.
 *
 * The projector's contract is exactly {@link EpicProjectedSlices}: it
 * stabilises a freshly-computed projection against the one already published
 * and republishes whole slices. The records plane publishes those slices plus
 * the record tables, the snapshot metadata and the divergence triple, and those
 * belong to the same plane's answer about the same rows.
 *
 * `ProjectionSink` is invariant in its projection (it both reads and writes
 * one), so the wider sink is not assignable to the narrower one and this view
 * is the composition the shared module asks for rather than a cast. `publish`
 * folds the projector's slices over the sink's CURRENT value - including one
 * buffered inside an open transaction - so a record ingest and the projection
 * it forces build on each other instead of overwriting.
 */
export function projectedSlicesView(
  sink: ProjectionSink<EpicRecordsProjection>,
): ProjectionSink<EpicProjectedSlices> {
  return {
    read(): EpicProjectedSlices {
      return sink.read();
    },
    publish(next: EpicProjectedSlices): void {
      sink.publish({ ...sink.read(), ...next });
    },
    transact(body: () => void): void {
      sink.transact(body);
    },
    revision(): number {
      return sink.revision();
    },
  };
}
