/**
 * `HotBodyBudget` over the tier's existing `HotDocBudgetSink`.
 *
 * ONE accountant. The sink is already an adapter onto T5's process accountant
 * (`epic-replica-runtime.ts` builds it: every member delegates into
 * `memory.hotDocs` / `memory.epicReplicas` and reconciles the plane), so the
 * lease bridge charges through the same book the tier does. Constructing a
 * second `HotBodyBudget` implementation anywhere on this path is the defect
 * this adapter exists to prevent.
 */
import type { HotDocBudgetSink } from "@/stores/replica-memory/hot-doc-budget";
import type { HotBodyBudget } from "./artifact-body-lease-bridge";

export function createHotBodyBudgetAdapter(
  sink: HotDocBudgetSink,
): HotBodyBudget {
  return {
    chargeHot: (docKey, bytes) => {
      // `settle`, NOT `chargeProvisional`, and this is not interchangeable.
      //
      // `chargeProvisional(id, deltaBytes)` takes an INCREMENT: the tier
      // accumulates it against `entry.hotBytesSinceSettle` and re-settles when
      // the total crosses a threshold. `settle(id, bytes)` takes an ABSOLUTE
      // `Y.encodeStateAsUpdate(doc).byteLength` and zeroes that accumulator.
      //
      // A newly materialized doc's `update.byteLength` is an absolute measure.
      // Sending it through the increment channel would add a whole document's
      // size to a running delta on every materialize - silently, and always in
      // the over-reporting direction. Do not "simplify" this to
      // `chargeProvisional` because the member names line up.
      sink.settle(docKey, bytes);
    },
    settleCold: (docKey, _settledBytes) => {
      // Releases the HOT charge only. The cold figure is NOT recorded here:
      // cold bytes are the TIER's fact - it holds cold state for every room,
      // leased or not - and it reports them through its own `settleCold` at
      // `settleColdState`. One reporter per byte fact; recording the worker's
      // count here as well would double-count every demote.
      //
      // `settledBytes` still crosses the wire: it is the demote pin's oracle,
      // and the bridge asserts on it. It is simply not an accounting input on
      // this side.
      sink.release(docKey);
    },
  };
}
