import { describe, expect, it } from "vitest";
import {
  VARIANTS,
  eventsOfSlice,
  onStrandedRig,
  passFor,
  type PassKind,
  type RetryPolicy,
} from "@/lib/host/test-support/cloud-recovery-interleavings";
import { holdTimersForFile } from "@/lib/host/test-support/cloud-recovery-interleavings-suite";

/**
 * The walk of the sweep's events is split across files by the first event of
 * each sequence. The split into slices is a partition by construction; these
 * cases keep each slice walkable: it has a first event the walk can take from
 * the stranded read.
 */

const SLICES: readonly ("a" | "b")[] = ["a", "b"];
const KINDS: readonly PassKind[] = ["full", "core", "lifecycle"];
const POLICIES: readonly RetryPolicy[] = ["off", "app"];

const timers = holdTimersForFile();

describe("the slices of the walk over the sweep's events", () => {
  it.each(POLICIES)(
    "gives each slice a first event the walk can take, under retry policy %s",
    async (retry) => {
      for (const variant of VARIANTS) {
        for (const kind of KINDS) {
          const alphabet = passFor(kind, retry, "all").alphabet;
          const first = await onStrandedRig({ variant, retry, timers }, (rig) =>
            rig.enabled(alphabet),
          );

          for (const slice of SLICES) {
            const events = eventsOfSlice(slice, kind);

            expect(
              first.filter((event) => events.includes(event)),
            ).not.toHaveLength(0);
          }
        }
      }
    },
  );
});
