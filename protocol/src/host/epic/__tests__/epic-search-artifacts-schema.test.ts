import { describe, expect, it } from "vitest";
import { searchArtifactsRequestSchema } from "../unary-schemas";

function requestWithSubtreePath(subtreePath: string | null) {
  return {
    epicId: "epic-1",
    query: "needle",
    fields: { title: true, path: true, body: true },
    filters: { kinds: null, statuses: null, subtreePath },
    limit: 50,
  };
}

describe("searchArtifactsRequestSchema subtreePath", () => {
  it.each(["tickets", "tickets/child", "unicode/ñandú"])(
    "accepts relative POSIX path %s",
    (subtreePath) => {
      expect(
        searchArtifactsRequestSchema.safeParse(
          requestWithSubtreePath(subtreePath),
        ).success,
      ).toBe(true);
    },
  );

  it.each(["", "/absolute", ".", "..", "tickets/../escape", "tickets//child"])(
    "rejects unsafe subtree path %s",
    (subtreePath) => {
      expect(
        searchArtifactsRequestSchema.safeParse(
          requestWithSubtreePath(subtreePath),
        ).success,
      ).toBe(false);
    },
  );
});
