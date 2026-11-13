import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ALL_EVENTS,
  Rig,
  VARIANTS,
  firstEventsOf,
  passFor,
  type EventName,
  type PassKind,
  type RetryPolicy,
  type Slice,
} from "@/lib/host/test-support/cloud-recovery-interleavings";
import { HeldTimers } from "@/lib/host/test-support/held-timers";
import { appLogger } from "@/lib/logger";

/**
 * The walk of the sweep's events is split across files by the first event of
 * each sequence. These cases keep that split honest: the slices together take
 * every event the first step can take, and no event twice.
 */

const SLICES: readonly Exclude<Slice, "all">[] = ["a", "b"];
const KINDS: readonly PassKind[] = ["full", "core", "lifecycle"];
const POLICIES: readonly RetryPolicy[] = ["off", "app"];

const timers = new HeldTimers();

function eventsOf(
  slice: Exclude<Slice, "all">,
  kind: PassKind,
): readonly EventName[] {
  return firstEventsOf(slice, kind) ?? [];
}

/** The events the first step of a walk can take from the stranded read. */
async function firstStepEvents(
  variant: (typeof VARIANTS)[number],
  retry: RetryPolicy,
  alphabet: readonly EventName[],
): Promise<EventName[]> {
  const rig = new Rig(variant, retry, timers);
  try {
    await rig.strand();
    return rig.enabled(alphabet);
  } finally {
    rig.dispose();
  }
}

describe("the slices of the walk over the sweep's events", () => {
  beforeAll(() => {
    vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    timers.install();
  });
  afterAll(() => {
    timers.restore();
    vi.restoreAllMocks();
  });

  it.each(KINDS)(
    "names no first event of the %s pass in both slices",
    (kind) => {
      const [a, b] = SLICES.map((slice) => eventsOf(slice, kind));

      expect(a.filter((event) => b.includes(event))).toEqual([]);
    },
  );

  it.each(POLICIES)(
    "takes every first event of every pass between its slices, under retry policy %s",
    async (retry) => {
      for (const variant of VARIANTS) {
        for (const kind of KINDS) {
          const alphabet = passFor(kind, retry, "all").alphabet;
          const first = await firstStepEvents(variant, retry, alphabet);
          const sliced = SLICES.map((slice) =>
            first.filter((event) => eventsOf(slice, kind).includes(event)),
          );

          expect(sliced.flat().toSorted()).toEqual(first.toSorted());
          for (const part of sliced) expect(part.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it.each(KINDS)("walks every event of the %s pass somewhere", (kind) => {
    const sliced = SLICES.flatMap((slice) => eventsOf(slice, kind));

    expect([...ALL_EVENTS].toSorted()).toEqual(sliced.toSorted());
  });
});
