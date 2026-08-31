import { describe, expect, it } from "vitest";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import {
  resolveArtifactCommentThreads,
  selectLaneCommentThreads,
} from "@/hooks/comments/use-lane-comment-threads";

const ARTIFACT_ID = "artifact-1";

function threadFixture(threadId: string): CommentThreadWire {
  return {
    threadId,
    resolved: false,
    createdAt: 1,
    comments: [],
    data: { createdByUserId: "user-1" },
  };
}

describe("selectLaneCommentThreads", () => {
  it("returns null for a MISSING key - the lane has said nothing", () => {
    expect(selectLaneCommentThreads({}, ARTIFACT_ID)).toBeNull();
  });

  it("returns the empty array, NOT null, for a key present with zero threads", () => {
    const byArtifactId = { [ARTIFACT_ID]: [] };
    expect(selectLaneCommentThreads(byArtifactId, ARTIFACT_ID)).toEqual([]);
    expect(selectLaneCommentThreads(byArtifactId, ARTIFACT_ID)).not.toBeNull();
  });

  it("returns rows present under the key BY REFERENCE, not a copy", () => {
    const rows = [threadFixture("thread-1")];
    const byArtifactId = { [ARTIFACT_ID]: rows };
    expect(selectLaneCommentThreads(byArtifactId, ARTIFACT_ID)).toBe(rows);
  });

  it("treats a prototype property name as a missing own key, not the inherited function", () => {
    const byArtifactId: Record<string, readonly CommentThreadWire[]> = {};
    expect(selectLaneCommentThreads(byArtifactId, "toString")).toBeNull();
    expect(selectLaneCommentThreads(byArtifactId, "constructor")).toBeNull();
  });
});

describe("resolveArtifactCommentThreads", () => {
  it("prefers lane rows when present", () => {
    const laneThreads = [threadFixture("lane-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads,
      pollThreads: [threadFixture("poll-thread")],
      laneLive: true,
    });
    expect(result).toEqual({ threads: laneThreads, source: "state-lane" });
  });

  it("keeps source state-lane when the lane answer is EMPTY - an empty lane answer must not fall through to the poll", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: [],
      pollThreads: [threadFixture("poll-thread")],
      laneLive: true,
    });
    expect(result).toEqual({ threads: [], source: "state-lane" });
  });

  it("falls back to poll rows when the lane has said nothing", () => {
    const pollThreads = [threadFixture("poll-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads,
      laneLive: true,
    });
    expect(result).toEqual({ threads: pollThreads, source: "poll" });
  });

  it("returns source poll with an empty array when the poll answered zero threads", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads: [],
      laneLive: true,
    });
    expect(result).toEqual({ threads: [], source: "poll" });
  });

  it("is unknown - threads null, source null - only when BOTH sources are silent", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads: null,
      laneLive: true,
    });
    expect(result).toEqual({ threads: null, source: null });
  });

  /**
   * Lane rows win ONLY while the state lane's transport is live. A poll
   * answer that is strictly newer must not lose to stale RETAINED lane rows
   * once the lane has dropped - `resolveArtifactCommentThreads` used to
   * prefer lane rows whenever the key was present, with no regard for
   * whether the transport backing them was still connected.
   */
  it("falls back to poll rows once the lane is no longer live, even though lane rows are present", () => {
    const laneThreads = [threadFixture("stale-lane-thread")];
    const pollThreads = [threadFixture("fresh-poll-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads,
      pollThreads,
      laneLive: false,
    });
    // THE REDDENING ONE - today this still returns `source: "state-lane"`
    // with the stale lane rows, because presence alone decides.
    expect(result).toEqual({ threads: pollThreads, source: "poll" });
  });

  it("keeps the RETAINED lane rows (never null) when the lane drops and the poll has nothing either", () => {
    const laneThreads = [threadFixture("retained-lane-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads,
      pollThreads: null,
      laneLive: false,
    });
    expect(result).toEqual({ threads: laneThreads, source: "state-lane" });
    // Explicitly not null: retention across a flaky connection is a
    // documented design goal, not an accidental non-null.
    expect(result.threads).not.toBeNull();
  });

  // D.9 - CONTROL, green both sides. The retained-rows pin above only uses a
  // NON-EMPTY array, so nothing holds the EMPTY case - and `[]` is exactly
  // what a `laneThreads.length > 0` "simplification" of the third arm would
  // turn into `null`, silently converting "this artifact has no threads"
  // into "unknown". This guards the empty-vs-unknown distinction on the
  // retained-rows arm, not the ordering the two pins above already cover.
  it("keeps the retained EMPTY lane array (not null) when the lane drops and the poll has nothing either", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: [],
      pollThreads: null,
      laneLive: false,
    });
    expect(result.threads).toEqual([]);
    expect(result.threads).not.toBeNull();
    expect(result.source).toBe("state-lane");
  });

  it("still prefers lane rows over the poll while the lane IS live - the control arm", () => {
    const laneThreads = [threadFixture("live-lane-thread")];
    const pollThreads = [threadFixture("poll-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads,
      pollThreads,
      laneLive: true,
    });
    expect(result).toEqual({ threads: laneThreads, source: "state-lane" });
  });

  it("falls back to poll rows when the lane has said nothing, regardless of liveness - unchanged fallback", () => {
    const pollThreads = [threadFixture("poll-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads,
      laneLive: false,
    });
    expect(result).toEqual({ threads: pollThreads, source: "poll" });
  });
});
