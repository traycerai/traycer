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
    });
    expect(result).toEqual({ threads: laneThreads, source: "state-lane" });
  });

  it("keeps source state-lane when the lane answer is EMPTY - an empty lane answer must not fall through to the poll", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: [],
      pollThreads: [threadFixture("poll-thread")],
    });
    expect(result).toEqual({ threads: [], source: "state-lane" });
  });

  it("falls back to poll rows when the lane has said nothing", () => {
    const pollThreads = [threadFixture("poll-thread")];
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads,
    });
    expect(result).toEqual({ threads: pollThreads, source: "poll" });
  });

  it("returns source poll with an empty array when the poll answered zero threads", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads: [],
    });
    expect(result).toEqual({ threads: [], source: "poll" });
  });

  it("is unknown - threads null, source null - only when BOTH sources are silent", () => {
    const result = resolveArtifactCommentThreads({
      laneThreads: null,
      pollThreads: null,
    });
    expect(result).toEqual({ threads: null, source: null });
  });
});
