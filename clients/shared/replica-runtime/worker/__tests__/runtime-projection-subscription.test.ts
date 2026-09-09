/**
 * The ordering reducer, driven directly.
 *
 * A pure unit, deliberately: the reducer is not where the risk lives. Whether
 * a spawned worker's projection stream actually reaches it is a WIRING
 * question, and that is pinned on the spawner
 * (`spawn-epic-runtime-worker.test.ts`) - a reducer suite cannot see a
 * projection arm that forgot to call it.
 *
 * What is pinned here is the property that makes whole-value publication safe:
 * an already-applied revision must be dropped. With patches an out-of-order
 * delivery corrupts visibly; with whole values it installs an older,
 * internally consistent slice that nothing downstream can distinguish from a
 * real update, and the UI silently goes backwards.
 */
import { describe, expect, it } from "vitest";
import { createRuntimeProjectionOrdering } from "../runtime-projection-subscription";

interface Slice {
  readonly title: string;
}

function setup() {
  const applied: Array<{ readonly value: Slice; readonly revision: number }> =
    [];
  const rejected: Array<{
    readonly reason: string;
    readonly revision: number;
  }> = [];
  const ordering = createRuntimeProjectionOrdering<Slice>({
    accept: (value) =>
      typeof value === "object" &&
      value !== null &&
      "title" in value &&
      typeof value.title === "string"
        ? { title: value.title }
        : null,
    apply: (value, revision) => applied.push({ value, revision }),
    reject: (reason, revision) => rejected.push({ reason, revision }),
  });
  return { ordering, applied, rejected };
}

describe("createRuntimeProjectionOrdering", () => {
  it("applies publications in order", () => {
    const { ordering, applied } = setup();

    ordering.deliver(1, { title: "a" });
    ordering.deliver(2, { title: "b" });

    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "b" }, revision: 2 },
    ]);
  });

  it("drops a revision it has already applied instead of rolling the slice back", () => {
    const { ordering, applied, rejected } = setup();

    ordering.deliver(2, { title: "b" });
    ordering.deliver(1, { title: "a" });
    ordering.deliver(2, { title: "b2" });

    expect(applied).toEqual([{ value: { title: "b" }, revision: 2 }]);
    expect(rejected).toEqual([
      { reason: "stale", revision: 1 },
      { reason: "stale", revision: 2 },
    ]);
  });

  it("does not advance the watermark on a slice it could not narrow", () => {
    const { ordering, applied, rejected } = setup();

    ordering.deliver(1, { nope: 1 });
    // The same revision, now recognisable. Advancing on the rejection would
    // have frozen the projection permanently from one skewed frame.
    ordering.deliver(1, { title: "a" });

    expect(rejected).toEqual([{ reason: "unrecognised", revision: 1 }]);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);
  });
});
