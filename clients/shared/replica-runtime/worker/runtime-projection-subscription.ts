/**
 * The main-thread end of the projection channel.
 * The worker publishes whole slices, never patches - the projection sink has always worked that way, and T3's fixture rule exists because a test that forces one field is order-dependent on the next publish.
 */

export interface RuntimeProjectionHandlers<TProjection> {
  /**
   * Narrows a published slice, or answers `null` if it is not one.
   * Both ends ship in one bundle graph, so this may legitimately be a cheap envelope check rather than a full validator - what it must not be is absent, because then nothing distinguishes a slice from a foreign payload.
   */
  accept(value: unknown): TProjection | null;
  /** Called once per accepted, in-order publication. */
  apply(value: TProjection, revision: number): void;
  /** A publication that could not be narrowed, or one whose revision had already been applied. */
  reject(reason: "unrecognised" | "stale", revision: number): void;
}

/**
 * The ordering itself, as a value with no knowledge of where publications come from.
 * Two watermarks would drop each other's deliveries as stale - a projection that updates half the time.
 */
export interface RuntimeProjectionOrdering {
  deliver(revision: number, value: unknown): void;
}

export function createRuntimeProjectionOrdering<TProjection>(
  handlers: RuntimeProjectionHandlers<TProjection>,
): RuntimeProjectionOrdering {
  // Starts below every real revision: the sink's first delivery is 1.
  let appliedRevision = 0;
  return {
    deliver(revision, value): void {
      if (revision <= appliedRevision) {
        handlers.reject("stale", revision);
        return;
      }
      const accepted = handlers.accept(value);
      if (accepted === null) {
        handlers.reject("unrecognised", revision);
        return;
      }
      // Advanced only on a publication that was actually applied.
      appliedRevision = revision;
      handlers.apply(accepted, revision);
    },
  };
}
