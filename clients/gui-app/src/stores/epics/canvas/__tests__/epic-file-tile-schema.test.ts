import { describe, expect, it } from "vitest";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import { makeEpicFileTileRef } from "@/stores/epics/canvas/tile-schema/epic-file-tile";

/**
 * A restored epic-file tile is a pointer the host reads bytes and decides a
 * page's network policy from, so a damaged one is dropped rather than
 * repaired into a different request.
 */

const SHA = "a".repeat(64);

function persisted(overrides: Record<string, unknown>): unknown {
  const ref = makeEpicFileTileRef({
    path: "files/pages/report.html",
    sha256: SHA,
    name: "Report",
    hostId: "host-1",
    via: { chatId: "chat-1", blockId: "block-1" },
  });
  return { ...JSON.parse(JSON.stringify(serializeTileRef(ref))), ...overrides };
}

describe("epic-file tile schema", () => {
  it("round-trips a tile opened from a row, and one opened from none", () => {
    expect(parseTileRef(persisted({}))).toMatchObject({
      path: "files/pages/report.html",
      sha256: SHA,
      via: { chatId: "chat-1", blockId: "block-1" },
    });
    expect(parseTileRef(persisted({ via: null }))).toMatchObject({
      via: null,
    });
  });

  it.each([
    ["a via missing its block", { via: { chatId: "chat-1" } }],
    ["a via that is not an object", { via: "chat-1" }],
    ["no via at all", { via: undefined }],
    ["a path outside files/", { path: "pages/report.html" }],
    ["a path that climbs out", { path: "files/../secrets" }],
    ["a short sha", { sha256: "abc" }],
    ["an uppercase sha", { sha256: "A".repeat(64) }],
  ])("drops a tile with %s", (_case, overrides) => {
    expect(parseTileRef(persisted(overrides))).toBeNull();
  });
});
