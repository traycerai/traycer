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
  let resyncCount = 0;
  const ordering = createRuntimeProjectionOrdering<Slice>(
    {
      accept: (value) =>
        typeof value === "object" &&
        value !== null &&
        "title" in value &&
        typeof value.title === "string"
          ? { title: value.title }
          : null,
      apply: (value, revision) => applied.push({ value, revision }),
      reject: (reason, revision) => rejected.push({ reason, revision }),
    },
    () => {
      resyncCount += 1;
    },
  );
  return { ordering, applied, rejected, resyncCount: () => resyncCount };
}

describe("createRuntimeProjectionOrdering", () => {
  it("applies publications in order", () => {
    const { ordering, applied } = setup();

    ordering.deliver(1, { title: "a" }, 0);
    ordering.deliver(2, { title: "b" }, 1);

    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "b" }, revision: 2 },
    ]);
  });

  it("drops a revision it has already applied instead of rolling the slice back", () => {
    const { ordering, applied, rejected } = setup();

    ordering.deliver(2, { title: "b" }, 0);
    ordering.deliver(1, { title: "a" }, 0);
    ordering.deliver(2, { title: "b2" }, 0);

    expect(applied).toEqual([{ value: { title: "b" }, revision: 2 }]);
    expect(rejected).toEqual([
      { reason: "stale", revision: 1 },
      { reason: "stale", revision: 2 },
    ]);
  });

  it("does not advance the watermark on a slice it could not narrow, and blocks deltas until a snapshot repairs it", () => {
    const { ordering, applied, rejected, resyncCount } = setup();

    ordering.deliver(1, { nope: 1 }, 0);
    expect(rejected).toEqual([{ reason: "unrecognised", revision: 1 }]);
    expect(resyncCount()).toBe(1);

    // The same revision, now recognisable, but pending - a delta cannot
    // repair this, only a snapshot can.
    ordering.deliver(1, { title: "a" }, 0);
    expect(applied).toEqual([]);

    ordering.deliver(1, { title: "a" }, null);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);
  });

  it("leaves a revision whose apply threw re-deliverable, instead of freezing it as applied", () => {
    const applied: Array<{ readonly value: Slice; readonly revision: number }> =
      [];
    const rejected: Array<{
      readonly reason: string;
      readonly revision: number;
    }> = [];
    let resyncCount = 0;
    let throwOnce = true;
    const ordering = createRuntimeProjectionOrdering<Slice>(
      {
        accept: (value) =>
          typeof value === "object" &&
          value !== null &&
          "title" in value &&
          typeof value.title === "string"
            ? { title: value.title }
            : null,
        apply: (value, revision) => {
          if (throwOnce) {
            throwOnce = false;
            throw new Error("apply blew up");
          }
          applied.push({ value, revision });
        },
        reject: (reason, revision) => rejected.push({ reason, revision }),
      },
      () => {
        resyncCount += 1;
      },
    );

    ordering.deliver(1, { title: "a" }, 0);

    expect(rejected).toEqual([{ reason: "apply-error", revision: 1 }]);
    expect(resyncCount).toBe(1);
    expect(applied).toEqual([]);

    // A revision whose apply failed stays repairable, not stale.
    ordering.deliver(1, { title: "a" }, null);

    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);
  });

  it("requests one resync for a gap and drops deltas until a snapshot repairs it", () => {
    const { ordering, applied, rejected, resyncCount } = setup();

    ordering.deliver(1, { title: "a" }, 0);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);

    // baseRevision 3 does not match the applied watermark (1): a gap.
    ordering.deliver(5, { title: "e" }, 3);
    expect(rejected).toContainEqual({ reason: "gap", revision: 5 });
    expect(resyncCount()).toBe(1);

    // Still pending: must not ask again, must not apply.
    ordering.deliver(6, { title: "f" }, 3);
    expect(resyncCount()).toBe(1);
    expect(applied).toEqual([{ value: { title: "a" }, revision: 1 }]);

    // A snapshot (baseRevision null) always heals.
    ordering.deliver(7, { title: "g" }, null);
    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "g" }, revision: 7 },
    ]);

    // Ordinary delivery resumes against the repaired watermark.
    ordering.deliver(8, { title: "h" }, 7);
    expect(applied).toEqual([
      { value: { title: "a" }, revision: 1 },
      { value: { title: "g" }, revision: 7 },
      { value: { title: "h" }, revision: 8 },
    ]);
  });

  it("throws instead of spinning another resync when the repair snapshot itself fails to apply", () => {
    const rejected: Array<{
      readonly reason: string;
      readonly revision: number;
    }> = [];
    let resyncCount = 0;
    const ordering = createRuntimeProjectionOrdering<Slice>(
      {
        accept: (value) =>
          typeof value === "object" &&
          value !== null &&
          "title" in value &&
          typeof value.title === "string"
            ? { title: value.title }
            : null,
        apply: (_value, revision) => {
          throw new Error(`apply blew up at revision ${String(revision)}`);
        },
        reject: (reason, revision) => rejected.push({ reason, revision }),
      },
      () => {
        resyncCount += 1;
      },
    );

    ordering.deliver(1, { title: "a" }, 0);
    expect(resyncCount).toBe(1);

    // The repair snapshot fails too - must surface, not spin another resync.
    expect(() => ordering.deliver(2, { title: "b" }, null)).toThrow();
    expect(resyncCount).toBe(1);
  });
});
