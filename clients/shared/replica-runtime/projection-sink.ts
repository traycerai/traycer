/**
 * Where a replica publishes what the UI reads.
 * The sink is deliberately a write surface with a read-back, not a store.
 */

export interface ProjectionSink<TProjection> {
  /**
   * The most recently published value - including one buffered inside an open transaction, so a second computation in the same transaction builds on the first rather than on pre-transaction state.
   * Without a read-back, a full re-projection would hand every row a fresh reference and re-render the whole tree on one rename.
   */
  read(): TProjection;

  /** Publish a complete projection. */
  publish(next: TProjection): void;

  /**
   * Run `body` with publication suspended, then publish once.
   * A scoped call is the same guarantee without the "who is responsible for calling resume on the throwing path" question - `body` throwing still ends the transaction.
   */
  transact(body: () => void): void;

  /**
   * How many times this sink has delivered.
   * The open-epic session registry's eligibility key is the shape to imitate: it exists precisely because a per-keystroke revision bump must not re-run an mru walk.
   */
  revision(): number;
}

/**
 * The callback a sink invokes when a value actually reaches the consumer.
 * Separate from `publish` so the buffering rules live in one place and every host application - zustand today, a `postMessage` bridge once the runtime moves into the worker - implements only the delivery.
 */
export type ProjectionDelivery<TProjection> = (
  value: TProjection,
  revision: number,
) => void;

/**
 * The reference sink: buffers inside transactions, delivers outside them.
 * Scaffolding rather than the production sink - it defines what `transact` means so the three planes that will use it cannot each invent a different answer for nested transactions and empty transactions.
 */
export function createTransactionalProjectionSink<TProjection>(
  initial: NoInfer<TProjection>,
  deliver: ProjectionDelivery<TProjection>,
): ProjectionSink<TProjection> {
  let current: TProjection = initial;
  let depth = 0;
  let dirty = false;
  // Named apart from the `revision()` accessor below so a reader is never
  // asking whether the method shadows the binding inside its own body.
  let deliveredRevision = 0;

  function flush(): void {
    if (!dirty) return;
    dirty = false;
    deliveredRevision += 1;
    deliver(current, deliveredRevision);
  }

  return {
    read(): TProjection {
      return current;
    },
    publish(next: TProjection): void {
      current = next;
      dirty = true;
      if (depth === 0) flush();
    },
    transact(body: () => void): void {
      depth += 1;
      try {
        body();
      } finally {
        depth -= 1;
        if (depth === 0) flush();
      }
    },
    revision(): number {
      return deliveredRevision;
    },
  };
}
