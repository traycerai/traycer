import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  applyTabRecordingEnded,
  applyTabRecordingLive,
  applyTabRecordingStarted,
  forgetOwnedTabRecordings,
  IDLE_TAB_RECORDING,
  isTabRecordingInFlight,
  resetTabRecordingsForTests,
  useTabRecordingState,
  type TabRecordingStatus,
} from "../tab-recording-store";

const HOST = "host-1";
const OTHER_HOST = "host-2";
const TAB = "tab-1";
const OTHER_TAB = "tab-2";
const RECORDING = "recording-1";

function state(hostId: string, tabId: string) {
  return renderHook(() => useTabRecordingState(hostId, tabId)).result.current;
}

beforeEach(() => {
  resetTabRecordingsForTests();
});

describe("applyTabRecordingStarted", () => {
  it("puts the tab at starting with the recordingId", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });

    expect(state(HOST, TAB)).toEqual({
      status: "starting",
      recordingId: RECORDING,
      reason: null,
    });
  });

  it("leaves a different tab on the same host idle", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });

    expect(state(HOST, OTHER_TAB)).toBe(IDLE_TAB_RECORDING);
  });

  it("leaves the same tab id on a different host idle", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });

    expect(state(OTHER_HOST, TAB)).toBe(IDLE_TAB_RECORDING);
  });
});

describe("applyTabRecordingLive", () => {
  it("moves a started recording to recording", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });

    applyTabRecordingLive(RECORDING);

    expect(state(HOST, TAB)).toEqual({
      status: "recording",
      recordingId: RECORDING,
      reason: null,
    });
  });
});

describe("applyTabRecordingEnded", () => {
  it("moves a live recording to ended and drops the index so it can't be settled again", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });
    applyTabRecordingLive(RECORDING);

    applyTabRecordingEnded({
      recordingId: RECORDING,
      status: "ended",
      reason: null,
    });

    expect(state(HOST, TAB)).toEqual({
      status: "ended",
      recordingId: RECORDING,
      reason: null,
    });

    // The index entry for RECORDING is gone, so a late `recordingHelperReady`
    // for the same id is a no-op rather than reviving the ended tab.
    applyTabRecordingLive(RECORDING);

    expect(state(HOST, TAB)).toEqual({
      status: "ended",
      recordingId: RECORDING,
      reason: null,
    });
  });

  it("keeps the reason when the client refuses to serve a recording", () => {
    applyTabRecordingStarted({
      owner: Symbol("coordinator"),
      hostId: HOST,
      tabId: TAB,
      recordingId: RECORDING,
    });

    applyTabRecordingEnded({
      recordingId: RECORDING,
      status: "refused",
      reason: "no-recording-helper-runtime",
    });

    expect(state(HOST, TAB)).toEqual({
      status: "refused",
      recordingId: RECORDING,
      reason: "no-recording-helper-runtime",
    });
  });

  it("drops a frame for a recordingId that was never started - no tab is materialised", () => {
    applyTabRecordingEnded({
      recordingId: "never-started",
      status: "ended",
      reason: null,
    });

    expect(state(HOST, TAB)).toBe(IDLE_TAB_RECORDING);
  });
});

describe("a second recording started on the same tab", () => {
  it("wins, and settling the first recordingId afterwards does not move the tab", () => {
    const owner = Symbol("coordinator");
    const FIRST = "recording-first";
    const SECOND = "recording-second";

    applyTabRecordingStarted({
      owner,
      hostId: HOST,
      tabId: TAB,
      recordingId: FIRST,
    });
    applyTabRecordingStarted({
      owner,
      hostId: HOST,
      tabId: TAB,
      recordingId: SECOND,
    });

    expect(state(HOST, TAB)).toEqual({
      status: "starting",
      recordingId: SECOND,
      reason: null,
    });

    // The older recordingId no longer indexes this tab, so settling it must
    // not move the badge that now belongs to the second recording.
    applyTabRecordingEnded({
      recordingId: FIRST,
      status: "ended",
      reason: null,
    });

    expect(state(HOST, TAB)).toEqual({
      status: "starting",
      recordingId: SECOND,
      reason: null,
    });

    applyTabRecordingLive(SECOND);

    expect(state(HOST, TAB)).toEqual({
      status: "recording",
      recordingId: SECOND,
      reason: null,
    });
  });
});

describe("forgetOwnedTabRecordings", () => {
  it("clears only the calling owner's tabs and leaves another owner's tab untouched", () => {
    const ownerA = Symbol("coordinator-a");
    const ownerB = Symbol("coordinator-b");

    applyTabRecordingStarted({
      owner: ownerA,
      hostId: HOST,
      tabId: TAB,
      recordingId: "recording-a",
    });
    applyTabRecordingStarted({
      owner: ownerB,
      hostId: HOST,
      tabId: OTHER_TAB,
      recordingId: "recording-b",
    });

    forgetOwnedTabRecordings(ownerA);

    expect(state(HOST, TAB)).toBe(IDLE_TAB_RECORDING);
    expect(state(HOST, OTHER_TAB)).toEqual({
      status: "starting",
      recordingId: "recording-b",
      reason: null,
    });
  });
});

describe("isTabRecordingInFlight", () => {
  it.each<{ status: TabRecordingStatus; expected: boolean }>([
    { status: "starting", expected: true },
    { status: "recording", expected: true },
    { status: "idle", expected: false },
    { status: "ended", expected: false },
    { status: "refused", expected: false },
  ])("$status -> $expected", ({ status, expected }) => {
    expect(isTabRecordingInFlight(status)).toBe(expected);
  });
});
