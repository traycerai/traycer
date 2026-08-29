/**
 * The main-thread end of the projection channel.
 *
 * The worker publishes WHOLE slices, never patches - the projection sink has
 * always worked that way, and T3's fixture rule exists because a test that
 * forces one field is order-dependent on the next publish. Whole values make
 * the boundary simple and make one property load-bearing: **publications must
 * be applied in order, and a revision already applied must be DROPPED.**
 *
 * With patches, an out-of-order delivery corrupts visibly. With whole values it
 * does not corrupt at all - it silently rolls the UI back to an older slice
 * that is internally consistent and simply stale, which no downstream
 * assertion can distinguish from a legitimate update. So the guard lives here,
 * once, rather than in each consumer.
 *
 * The slice's TYPE is the store's, not this module's. It arrives as `unknown`
 * and the composition root supplies the narrowing - the same shape as a call
 * response parser, and for the same reason: a boundary that hard-codes the
 * store's shape drifts the first time the store's owner adds a field.
 */
import type { MainBridgeEndpoint } from "./bridge-endpoint";

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
  /**
   * A publication that could not be narrowed, or one whose revision had
   * already been applied. Separated from `apply` because they are different
   * faults: the first is skew, the second is a delivery-order bug, and a
   * consumer that logged them identically would investigate the wrong one.
   */
  reject(reason: "unrecognised" | "stale", revision: number): void;
}

/**
 * The ordering itself, as a value with no knowledge of where publications come
 * from.
 *
 * Split out from the subscription because the watermark must be held in
 * exactly ONE place. Production wires projections through the spawner's
 * `onProjection` port, so if this module also subscribed to the bridge
 * directly there would be two watermarks over one stream, each dropping the
 * other's deliveries as stale - a failure that looks like a projection that
 * updates half the time.
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
      // Advanced only on a publication that was actually applied. Advancing on
      // a rejected one would make the NEXT good publication at that revision
      // look stale, turning one skewed frame into a permanently frozen
      // projection.
      appliedRevision = revision;
      handlers.apply(accepted, revision);
    },
  };
}

/**
 * Subscribes an ordering directly to a bridge. Returns the unsubscribe.
 *
 * For a caller that owns its bridge outright. The production composition root
 * does NOT use this - it hands `ordering.deliver` to the spawner, which owns
 * the one subscription - so reaching for it beside a spawned worker is the
 * two-watermark mistake described above.
 */
export function subscribeRuntimeProjection<TProjection>(
  bridge: MainBridgeEndpoint,
  handlers: RuntimeProjectionHandlers<TProjection>,
): () => void {
  const ordering = createRuntimeProjectionOrdering(handlers);
  return bridge.onEvent((event) => {
    if (event.kind !== "projection") return;
    ordering.deliver(event.revision, event.value);
  });
}
