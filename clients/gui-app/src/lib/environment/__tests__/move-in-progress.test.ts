import { describe, expect, it } from "vitest";
import {
  moveHasStopped,
  moveIsPastTheAccept,
  moveIsRunning,
} from "@/lib/environment/move-in-progress";
import {
  moveAttemptFixture,
  unboundMoveStatusFixture,
} from "@/lib/environment/__tests__/environment-test-support";

/*
 * The one table that holds the predicates' meaning for an accepted move: the
 * open record (`status.move` running or retry) carries the guard through
 * registering and the moving settings window, and stops short of applying,
 * which comes after the upload has ended, and of a stage this app does not
 * know: both are read from `setup` alone.
 */

const OPEN_RECORDS = ["running", "retry"] as const;

describe("an accepted move's reading by stage", () => {
  it.each([
    {
      name: "registering, running",
      stage: "registering",
      state: "running",
      pastTheAccept: true,
      stopped: false,
      running: true,
    },
    {
      name: "registering, stalled",
      stage: "registering",
      state: "stalled",
      pastTheAccept: true,
      stopped: true,
      running: false,
    },
    {
      name: "registering, failed",
      stage: "registering",
      state: "failed",
      pastTheAccept: true,
      stopped: true,
      running: false,
    },
    {
      name: "the moving settings window",
      stage: "moving_settings",
      state: "awaiting_consent",
      pastTheAccept: true,
      stopped: false,
      running: true,
    },
    {
      name: "moving settings, running",
      stage: "moving_settings",
      state: "running",
      pastTheAccept: true,
      stopped: false,
      running: true,
    },
    {
      name: "moving settings, stalled",
      stage: "moving_settings",
      state: "stalled",
      pastTheAccept: true,
      stopped: true,
      running: false,
    },
    {
      name: "applying, running",
      stage: "applying",
      state: "running",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
    {
      name: "applying, stalled",
      stage: "applying",
      state: "stalled",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
    {
      name: "applying, failed",
      stage: "applying",
      state: "failed",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
    {
      name: "done",
      stage: "done",
      state: "done",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
    {
      name: "a stage this app does not know, running",
      stage: "verifying",
      state: "running",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
    {
      name: "a stage this app does not know, stalled",
      stage: "verifying",
      state: "stalled",
      pastTheAccept: false,
      stopped: false,
      running: false,
    },
  ])(
    "reads $name as past the accept: $pastTheAccept, stopped: $stopped, running: $running, whichever open record the host serves",
    ({ stage, state, pastTheAccept, stopped, running }) => {
      for (const record of OPEN_RECORDS) {
        const status = unboundMoveStatusFixture(
          { stage, state },
          moveAttemptFixture(record),
        );
        expect(moveIsPastTheAccept(status)).toBe(pastTheAccept);
        expect(moveHasStopped(status)).toBe(stopped);
        expect(moveIsRunning(status)).toBe(running);
      }
    },
  );

  it.each([{ state: "running" }, { state: "stalled" }])(
    "reads a stage this app does not know ($state) as it reads the same status with no record, whichever open record the host serves",
    ({ state }) => {
      const setup = { stage: "verifying", state };
      const withoutRecord = unboundMoveStatusFixture(setup, null);
      for (const record of OPEN_RECORDS) {
        const status = unboundMoveStatusFixture(
          setup,
          moveAttemptFixture(record),
        );
        expect(moveIsPastTheAccept(status)).toBe(
          moveIsPastTheAccept(withoutRecord),
        );
        expect(moveHasStopped(status)).toBe(moveHasStopped(withoutRecord));
        expect(moveIsRunning(status)).toBe(moveIsRunning(withoutRecord));
      }
    },
  );

  it.each([
    ["registering, stalled", { stage: "registering", state: "stalled" }],
    [
      "the moving settings window",
      { stage: "moving_settings", state: "awaiting_consent" },
    ],
    ["applying, running", { stage: "applying", state: "running" }],
    ["applying, stalled", { stage: "applying", state: "stalled" }],
  ])(
    "reads a computer with no accepted move as not past the accept in %s",
    (_name, setup) => {
      expect(moveIsPastTheAccept(unboundMoveStatusFixture(setup, null))).toBe(
        false,
      );
    },
  );
});
