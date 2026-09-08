import { describe, expect, it } from "vitest";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import {
  epicFileTileId,
  epicFileTileName,
  epicFileTileSchema,
  makeEpicFileTileRef,
} from "@/stores/epics/canvas/tile-schema/epic-file-tile";
import { TILE_KIND_EPIC_FILE } from "@/stores/epics/canvas/tile-kinds";
import {
  isEpicFileTileRef,
  type EpicCanvasTileRef,
  type EpicFileTileRef,
} from "@/stores/epics/canvas/types";

const HOST = "host-1";
const EPIC_ID = "epic-1";
const PATH = "files/screenshots/step-1.png";

describe("makeEpicFileTileRef / round trip", () => {
  it("round-trips through serializeTileRef/parseTileRef", () => {
    const ref = makeEpicFileTileRef({
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });

    expect(ref.type).toBe(TILE_KIND_EPIC_FILE);
    expect(ref.id).toBe(epicFileTileId({ epicId: EPIC_ID, path: PATH }));
    expect(ref.name).toBe(epicFileTileName(PATH));
    expect(ref.name).toBe("step-1.png");

    const parsed = parseTileRef(serializeTileRef(ref));
    expect(parsed).toEqual(ref);
    expect(epicFileTileSchema.parse(epicFileTileSchema.serialize(ref))).toEqual(
      ref,
    );
  });

  it("mints a fresh instanceId per call, everything else deterministic", () => {
    const first = makeEpicFileTileRef({
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });
    const second = makeEpicFileTileRef({
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });

    expect(first.id).toBe(second.id);
    expect(first.instanceId).not.toBe(second.instanceId);
  });
});

describe("epicFileTileSchema.parse", () => {
  it("recomputes id and name from (epicId, path), ignoring bogus stored ones", () => {
    const parsed = epicFileTileSchema.parse({
      id: "bogus-stored-id",
      instanceId: "inst-1",
      type: TILE_KIND_EPIC_FILE,
      name: "totally-wrong-name.txt",
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(epicFileTileId({ epicId: EPIC_ID, path: PATH }));
    expect(parsed?.name).toBe("step-1.png");
  });

  it.each([
    ["a traversal", "../secrets"],
    ["an absolute path", "/abs/x"],
    ["the staging sibling", ".file-staging/x"],
    ["a dot-prefixed segment under files/", "files/.index.md"],
  ])("returns null for %s (%s)", (_label, path) => {
    const parsed = epicFileTileSchema.parse({
      id: "id",
      instanceId: "inst-1",
      type: TILE_KIND_EPIC_FILE,
      name: "name",
      hostId: HOST,
      epicId: EPIC_ID,
      path,
    });
    expect(parsed).toBeNull();
  });

  it("returns null for a missing epicId", () => {
    const parsed = epicFileTileSchema.parse({
      id: "id",
      instanceId: "inst-1",
      type: TILE_KIND_EPIC_FILE,
      name: "name",
      hostId: HOST,
      path: PATH,
    });
    expect(parsed).toBeNull();
  });

  it("returns null for an empty epicId", () => {
    const parsed = epicFileTileSchema.parse({
      id: "id",
      instanceId: "inst-1",
      type: TILE_KIND_EPIC_FILE,
      name: "name",
      hostId: HOST,
      epicId: "",
      path: PATH,
    });
    expect(parsed).toBeNull();
  });

  it("mints a fresh instanceId when absent", () => {
    const parsed = epicFileTileSchema.parse({
      id: "id",
      type: TILE_KIND_EPIC_FILE,
      name: "name",
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });

    expect(parsed).not.toBeNull();
    expect(typeof parsed?.instanceId).toBe("string");
    expect(parsed?.instanceId.length).toBeGreaterThan(0);
  });
});

describe("isEpicFileTileRef", () => {
  it("narrows only epic-file tiles", () => {
    const pointer: EpicFileTileRef = makeEpicFileTileRef({
      hostId: HOST,
      epicId: EPIC_ID,
      path: PATH,
    });
    const blank: EpicCanvasTileRef = {
      id: "blank",
      instanceId: "i2",
      type: "blank",
      name: "New tab",
      hostId: HOST,
    };

    expect(isEpicFileTileRef(pointer)).toBe(true);
    expect(isEpicFileTileRef(blank)).toBe(false);
  });
});
