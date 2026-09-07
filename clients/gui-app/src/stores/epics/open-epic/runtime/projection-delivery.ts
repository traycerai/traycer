/**
 * Where the runtime's three sinks actually land, and how a frame that touches more than one plane
 * still costs ONE store write. The shared sink deliberately stops at "publish a whole projection".
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
  /** Run `body`, coalescing every publish it produces into one commit. */
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
    // Cleared BEFORE the commit, not after: a subscriber woken by the commit can publish again
    // synchronously (the auth bridge's republish does), and clearing afterwards would drop that second
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
        // Commits even when `body` threw: a partially applied frame is still the runtime's current state,
        // and withholding it would leave the UI rendering something the replicas no longer hold.
        if (depth === 0) flush();
      }
    },
  };
}

/**
 * Adapt a plane's delivery into the shared sink's {@link ProjectionDelivery}. The revision is
 * dropped on purpose.
 */
export function deliverInto<TProjection extends Partial<EpicRuntimeProjection>>(
  delivery: EpicRuntimeDelivery,
): ProjectionDelivery<TProjection> {
  /** The last value DELIVERED for each top-level key, by reference. */
  const lastDelivered = new Map<string, unknown>();

  return (value: TProjection): void => {
    const next: Partial<EpicRuntimeProjection> = { ...value };
    for (const key of Object.keys(next)) {
      const candidate: unknown = Reflect.get(next, key);
      if (lastDelivered.has(key) && lastDelivered.get(key) === candidate) {
        Reflect.deleteProperty(next, key);
        continue;
      }
      lastDelivered.set(key, candidate);
    }
    // Nothing actually moved. The sink flushed because ITS revision advanced,
    // which is a fact about the sink rather than about the read model.
    if (Object.keys(next).length === 0) return;
    delivery.publish(next);
  };
}

/** A narrowing view of the records sink for the projector. */
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
