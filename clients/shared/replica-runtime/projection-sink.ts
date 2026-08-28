/**
 * Where a replica publishes what the UI reads.
 *
 * This replaces the direct `StoreApi<OpenEpicState>.setState` call the
 * projector holds today. That coupling is what makes the projection kernel -
 * otherwise ~3.4k lines of pure, React-free, plain-serializable-output code -
 * un-relocatable: `setState` is a zustand handle living on the main thread,
 * and the kernel is scheduled to run in a worker.
 *
 * The sink is deliberately a WRITE surface with a read-back, not a store.
 * Subscription, equality-based re-render skipping, and React integration stay
 * on the consumer's side of the seam; a zustand-backed sink is roughly ten
 * lines and belongs to whoever owns the store.
 */

export interface ProjectionSink<TProjection> {
  /**
   * The most recently published value - including one buffered inside an open
   * transaction, so a second computation in the same transaction builds on the
   * first rather than on pre-transaction state.
   *
   * Needed because the projector's stabilisation pass compares the projection
   * it just built against the one already published, to keep per-entry `===`
   * identity for the rows that did not change. Without a read-back, a full
   * re-projection would hand every row a fresh reference and re-render the
   * whole tree on one rename.
   */
  read(): TProjection;

  /**
   * Publish a complete projection.
   *
   * Whole values, never patches: the identity contract that makes selectors
   * cheap lives INSIDE the projection (unchanged rows keep their references),
   * so a patch protocol here would be a second, weaker copy of a guarantee the
   * kernel already provides - and one that cannot survive a structured clone.
   */
  publish(next: TProjection): void;

  /**
   * Run `body` with publication suspended, then publish once.
   *
   * The transaction concept that replaces the projector's `suspend()` /
   * `resume()` pair. Those exist because applying snapshot bytes to a `Y.Doc`
   * fires a burst of `observeDeep` events, each of which would schedule its own
   * partial update; the snapshot path suspends, applies, and re-projects once.
   * A scoped call is the same guarantee without the "who is responsible for
   * calling resume on the throwing path" question - `body` throwing still ends
   * the transaction.
   *
   * Nesting is allowed and only the OUTERMOST exit publishes. A transaction in
   * which nothing was published publishes nothing: an empty transaction must
   * not bump the revision, or every no-op frame would re-render the tree.
   */
  transact(body: () => void): void;

  /**
   * How many times this sink has DELIVERED. Increments once per delivery, not
   * once per {@link publish} - three publishes inside one transaction are one
   * revision, which is the whole point of having transactions.
   *
   * Consumers key cheap "has anything changed at all" checks on this. The
   * open-epic session registry's eligibility key is the shape to imitate: it
   * exists precisely because a per-keystroke revision bump must not re-run an
   * MRU walk.
   */
  revision(): number;
}

/**
 * The callback a sink invokes when a value actually reaches the consumer.
 *
 * Separate from `publish` so the buffering rules live in one place and every
 * host application - zustand today, a `postMessage` bridge once the runtime
 * moves into the worker - implements only the delivery.
 */
export type ProjectionDelivery<TProjection> = (
  value: TProjection,
  revision: number,
) => void;

/**
 * The reference sink: buffers inside transactions, delivers outside them.
 *
 * Scaffolding rather than the production sink - it defines what `transact`
 * MEANS so the three planes that will use it cannot each invent a different
 * answer for nested transactions and empty transactions. Compose it (deliver
 * into a zustand `setState`, or into a `postMessage`) rather than
 * reimplementing the buffering.
 */
export function createTransactionalProjectionSink<TProjection>(
  initial: TProjection,
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
        // Only the outermost exit delivers, and it delivers even when `body`
        // threw: a partially applied transaction is still the runtime's
        // current state, and withholding it would leave the UI rendering
        // something the replica no longer holds.
        if (depth === 0) flush();
      }
    },
    revision(): number {
      return deliveredRevision;
    },
  };
}
