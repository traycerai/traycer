/**
 * `HotBodyBudget` over the runtime's accounting port.
 *
 * ONE accountant. The port is the same one the store hands the runtime
 * (`createProcessBackedAccountingPort`), so the lease bridge charges through
 * the same book every other byte fact goes through. Constructing a second
 * `HotBodyBudget` implementation anywhere on this path is the defect this
 * adapter exists to prevent.
 *
 * **It used to take the tier's `HotDocBudgetSink`, and that stopped being
 * right.** The sink is built inside `epic-replica-runtime.ts`, so after the
 * relocation it lives in the WORKER - while the lease bridge and the docs it
 * counts are on main. A main-side bridge charging through a worker-side sink
 * is not a hop, it is a different thread's book. The accounting port is the
 * main-side surface that already exists for exactly this.
 */
import type { EpicRuntimeAccountingPort } from "../epic-runtime-accounting-port";
import type { HotBodyBudget } from "./artifact-body-lease-bridge";

export function createHotBodyBudgetAdapter(
  accounting: EpicRuntimeAccountingPort,
): HotBodyBudget {
  return {
    chargeHot: (docKey, bytes) => {
      // `settleHotDocBytes`, NOT `chargeHotDocProvisional`, and this is not
      // interchangeable.
      //
      // `chargeHotDocProvisional(id, deltaBytes)` takes an INCREMENT: the tier
      // accumulates it against `entry.hotBytesSinceSettle` and re-settles when
      // the total crosses a threshold. `settleHotDocBytes(id, bytes)` takes an
      // ABSOLUTE `Y.encodeStateAsUpdate(doc).byteLength` and zeroes that
      // accumulator.
      //
      // A newly materialized doc's `update.byteLength` is an absolute measure.
      // Sending it through the increment channel would add a whole document's
      // size to a running delta on every materialize - silently, and always in
      // the over-reporting direction. Do not "simplify" this to the
      // provisional call because the member names line up.
      accounting.settleHotDocBytes(docKey, bytes);
    },
    settleCold: (docKey, _settledBytes) => {
      // Releases the HOT charge only. The cold figure is NOT recorded here:
      // cold bytes are the TIER's fact - it holds cold state for every room,
      // leased or not - and it reports them through its own `settleColdRoomBytes`
      // when it settles. One reporter per byte fact; recording the worker's
      // count here as well would double-count every demote.
      //
      // `settledBytes` still crosses the wire: it is the demote pin's oracle,
      // and the bridge asserts on it. It is simply not an accounting input on
      // this side.
      accounting.releaseHotDoc(docKey);
    },
  };
}
