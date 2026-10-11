/**
 * The main-thread end of the projection channel.
 *
 * Publications must be applied in order, and a revision already applied must
 * be dropped. A missing base or failed apply requests a full worker snapshot.
 * Consumers may send whole slices or encode changed rows before transport.
 * Row deltas depend on every preceding accepted publication, while whole
 * slices would silently roll the UI back if an older revision were replayed.
 * Keep the guard here so both forms share the same ordering authority.
 *
 * The slice's TYPE is the store's, not this module's. It arrives as `unknown`
 * and the composition root supplies the narrowing - the same shape as a call
 * response parser, and for the same reason: a boundary that hard-codes the
 * store's shape drifts the first time the store's owner adds a field.
 */

export interface RuntimeProjectionHandlers<TProjection> {
  /**
   * Narrows a published slice, or answers `null` if it is not one.
   *
   * Both ends ship in one bundle graph, so this may legitimately be a cheap
   * envelope check rather than a full validator - what it must not be is
   * absent, because then nothing distinguishes a slice from a foreign payload.
   */
  accept(value: unknown): TProjection | null;
  /** Called once per accepted, in-order publication. */
  apply(value: TProjection, revision: number): void;
  /** Reports narrowing, ordering, and apply failures without advancing the watermark. */
  reject(
    reason: "unrecognised" | "stale" | "gap" | "apply-error",
    revision: number,
  ): void;
}

/**
 * The ordering itself, as a value with no knowledge of where publications come
 * from.
 *
 * A value rather than a subscription because the watermark must be held in
 * exactly ONE place, and that place is the spawner: it constructs one of these
 * per worker from the handlers its caller supplies, and hands back a port with
 * no `onEvent` on it, so a second reducer over the same stream is unreachable
 * rather than merely discouraged. Two watermarks would drop each other's
 * deliveries as stale - a projection that updates half the time.
 *
 * Nothing else should construct one. If a caller finds itself wanting to, the
 * question to answer first is which of the two is supposed to win.
 */
export interface RuntimeProjectionOrdering {
  deliver(revision: number, value: unknown, baseRevision: number | null): void;
}

export function createRuntimeProjectionOrdering<TProjection>(
  handlers: RuntimeProjectionHandlers<TProjection>,
  requestResync: () => void,
): RuntimeProjectionOrdering {
  let appliedRevision = 0;
  let resyncPending = false;
  function resync(): void {
    if (resyncPending) return;
    resyncPending = true;
    requestResync();
  }
  return {
    deliver(revision, value, baseRevision): void {
      if (revision <= appliedRevision) {
        handlers.reject("stale", revision);
        return;
      }
      if (
        baseRevision !== null &&
        (resyncPending || baseRevision !== appliedRevision)
      ) {
        handlers.reject("gap", revision);
        resync();
        return;
      }
      let failure: "unrecognised" | "apply-error" = "apply-error";
      try {
        const accepted = handlers.accept(value);
        if (accepted === null) {
          failure = "unrecognised";
          throw new Error("Unrecognised runtime projection");
        }
        handlers.apply(accepted, revision);
      } catch (cause: unknown) {
        handlers.reject(failure, revision);
        // A failed recovery snapshot cannot be repaired by requesting it forever.
        if (baseRevision === null && resyncPending) throw cause;
        resync();
        return;
      }
      appliedRevision = revision;
      resyncPending = false;
    },
  };
}
