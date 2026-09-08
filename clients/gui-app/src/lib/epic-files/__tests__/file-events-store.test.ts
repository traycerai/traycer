import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => {
  // `toast` is callable as well as a namespace elsewhere in the app; mirror
  // that shape even though this module only ever calls `toast.warning`.
  const base = vi.fn();
  return {
    toast: Object.assign(base, {
      warning: vi.fn(),
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

import { toast } from "sonner";
import type {
  EpicFileEventsServerFrame,
  EpicFileRefusalReason,
} from "@traycer/protocol/host/epic/files";
import {
  __resetEpicFileEventsForTests,
  clearEpicFileEvents,
  EPIC_FILE_REFUSAL_DEDUPE_MS,
  EPIC_FILE_REFUSAL_LIMIT,
  getEpicFileRefusals,
  recordEpicFileEvent,
  subscribeEpicFileRefusals,
  subscribeEpicRecordingEvents,
} from "@/lib/epic-files/file-events-store";
import {
  EMPTY_FILE_REFUSALS,
  EPIC_FILE_REFUSAL_COPY,
} from "@/lib/epic-files/file-refusals";

function refusedFrame(
  path: string,
  reason: EpicFileRefusalReason,
): EpicFileEventsServerFrame {
  return { kind: "refused", path, reason, hasBinaryPayload: false };
}

beforeEach(() => {
  __resetEpicFileEventsForTests();
  vi.mocked(toast.warning).mockClear();
  vi.useRealTimers();
});

describe("recordEpicFileEvent - refused frames", () => {
  it("appends a refusal named by the last path segment, with the mapped copy, and fires one toast", () => {
    const epicId = "epic-refusal-basic";

    recordEpicFileEvent(
      epicId,
      refusedFrame("files/sub/secret.env", "secret-shaped"),
    );

    const refusals = getEpicFileRefusals(epicId);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      name: "secret.env",
      reason: EPIC_FILE_REFUSAL_COPY["secret-shaped"],
    });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("secret.env", {
      description: EPIC_FILE_REFUSAL_COPY["secret-shaped"],
    });
  });

  it("caps refusals at EPIC_FILE_REFUSAL_LIMIT, newest first, dropping the oldest", () => {
    const epicId = "epic-refusal-cap";

    for (let i = 0; i < EPIC_FILE_REFUSAL_LIMIT + 1; i += 1) {
      recordEpicFileEvent(
        epicId,
        refusedFrame(`files/file-${i}.env`, "secret-shaped"),
      );
    }

    const refusals = getEpicFileRefusals(epicId);
    expect(refusals).toHaveLength(EPIC_FILE_REFUSAL_LIMIT);
    // Newest (last admitted) is at index 0.
    expect(refusals[0].name).toBe(`file-${EPIC_FILE_REFUSAL_LIMIT}.env`);
    // The oldest, distinct path was dropped once the cap was exceeded.
    expect(refusals.some((refusal) => refusal.name === "file-0.env")).toBe(
      false,
    );
  });

  it("dedupes the same (path, reason) pair within the window, admits a different reason, and re-admits once the window elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const epicId = "epic-refusal-dedupe";

    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    expect(getEpicFileRefusals(epicId)).toHaveLength(1);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    // A different reason on the same path is not deduped against the first.
    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "too-large"));
    expect(getEpicFileRefusals(epicId)).toHaveLength(2);
    expect(toast.warning).toHaveBeenCalledTimes(2);

    // After the dedupe window elapses the same pair is admitted again.
    vi.advanceTimersByTime(EPIC_FILE_REFUSAL_DEDUPE_MS);
    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    expect(getEpicFileRefusals(epicId)).toHaveLength(3);
    expect(toast.warning).toHaveBeenCalledTimes(3);
  });
});

describe("subscribeEpicFileRefusals", () => {
  it("fires only for an admitted refusal, not for a deduped one, and stops after unsubscribe", () => {
    const epicId = "epic-refusal-listener";
    const listener = vi.fn();
    const unsubscribe = subscribeEpicFileRefusals(epicId, listener);

    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    expect(listener).toHaveBeenCalledTimes(1);

    // Deduped: same (path, reason) immediately after.
    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    recordEpicFileEvent(epicId, refusedFrame("files/b.env", "secret-shaped"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeEpicRecordingEvents", () => {
  it("delivers recordingStarted with a null outcome and recordingEnded with the frame's outcome, scoped per epic", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubscribeA = subscribeEpicRecordingEvents("epic-a", listenerA);
    const unsubscribeB = subscribeEpicRecordingEvents("epic-b", listenerB);

    recordEpicFileEvent("epic-a", {
      kind: "recordingStarted",
      recordingId: "rec-1",
      tabId: "tab-1",
      hasBinaryPayload: false,
    });
    expect(listenerA).toHaveBeenCalledWith({
      kind: "recordingStarted",
      recordingId: "rec-1",
      tabId: "tab-1",
      outcome: null,
    });
    expect(listenerB).not.toHaveBeenCalled();

    recordEpicFileEvent("epic-a", {
      kind: "recordingEnded",
      recordingId: "rec-1",
      tabId: "tab-1",
      outcome: "saved",
      hasBinaryPayload: false,
    });
    expect(listenerA).toHaveBeenLastCalledWith({
      kind: "recordingEnded",
      recordingId: "rec-1",
      tabId: "tab-1",
      outcome: "saved",
    });
    expect(listenerB).not.toHaveBeenCalled();

    unsubscribeA();
    unsubscribeB();
  });
});

describe("recordEpicFileEvent - pong", () => {
  it("produces no refusal, no toast, and no recording event", () => {
    const epicId = "epic-pong";
    const recordingListener = vi.fn();
    const unsubscribe = subscribeEpicRecordingEvents(epicId, recordingListener);

    recordEpicFileEvent(epicId, { kind: "pong", hasBinaryPayload: false });

    expect(getEpicFileRefusals(epicId)).toEqual([]);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(recordingListener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("getEpicFileRefusals", () => {
  it("returns the same EMPTY_FILE_REFUSALS reference for an untouched epic", () => {
    const first = getEpicFileRefusals("epic-untouched");
    const second = getEpicFileRefusals("epic-untouched");
    expect(first).toBe(EMPTY_FILE_REFUSALS);
    expect(second).toBe(EMPTY_FILE_REFUSALS);
  });
});

describe("clearEpicFileEvents", () => {
  it("empties an epic's refusals and notifies listeners", () => {
    const epicId = "epic-clear";
    recordEpicFileEvent(epicId, refusedFrame("files/a.env", "secret-shaped"));
    expect(getEpicFileRefusals(epicId)).toHaveLength(1);

    const listener = vi.fn();
    const unsubscribe = subscribeEpicFileRefusals(epicId, listener);

    clearEpicFileEvents(epicId);

    expect(getEpicFileRefusals(epicId)).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
