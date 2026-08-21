import { describe, expect, it } from "vitest";
import {
  deletedArtifactsTileId,
  makeDeletedArtifactsTileRef,
} from "@/stores/epics/canvas/tile-schema/deleted-artifacts-tile";
import {
  isTileRefRecordBacked,
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";

const EPIC_ID = "epic-a";
const HOST_ID = "host-a";

describe("deleted-artifacts tile schema", () => {
  it("uses one stable content id per epic and host with fresh tab instances", () => {
    const first = makeDeletedArtifactsTileRef(EPIC_ID, HOST_ID);
    const second = makeDeletedArtifactsTileRef(EPIC_ID, HOST_ID);

    expect(first.id).toBe(deletedArtifactsTileId(EPIC_ID, HOST_ID));
    expect(second.id).toBe(first.id);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(makeDeletedArtifactsTileRef(EPIC_ID, "host-b").id).not.toBe(
      first.id,
    );
    expect(isTileRefRecordBacked(first)).toBe(false);
  });

  it("round-trips the lifetime host binding and repairs the content id", () => {
    const ref = makeDeletedArtifactsTileRef(EPIC_ID, HOST_ID);
    expect(parseTileRef(serializeTileRef(ref))).toEqual(ref);

    const parsed = parseTileRef({
      ...ref,
      id: "stale-id",
    });

    expect(parsed).toEqual({
      ...ref,
      id: deletedArtifactsTileId(EPIC_ID, HOST_ID),
    });
  });
});
