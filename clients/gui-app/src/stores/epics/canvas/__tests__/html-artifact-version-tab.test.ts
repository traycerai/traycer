import { describe, expect, it } from "vitest";
import type { HtmlArtifactVersionSelection } from "@traycer/protocol/host/epic/html-artifact-versions";
import {
  openTile,
  openTileInPane,
  updateHtmlArtifactVersion,
} from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import {
  parseTileRef,
  serializeTileRef,
} from "@/stores/epics/canvas/tile-schema";
import type { EpicArtifactRef } from "@/stores/epics/canvas/types";
import { TEST_HOST_ID } from "./canvas-test-fixtures";

const PINNED: HtmlArtifactVersionSelection = {
  manifest: {
    files: {
      "index.html": {
        sha256: "a".repeat(64),
        byteLength: 10,
        mediaType: "text/html",
      },
      "css/site.css": {
        sha256: "b".repeat(64),
        byteLength: 4,
        mediaType: "text/css",
      },
    },
    capturedAt: 1_000,
  },
  entryPath: "index.html",
};

function htmlTile(instanceId: string): EpicArtifactRef {
  return {
    id: "page-1",
    instanceId,
    type: "html",
    name: "Page",
    hostId: TEST_HOST_ID,
  };
}

describe("an html tile's pinned version", () => {
  it("survives serialization into the persisted tab and back", () => {
    const pinned: EpicArtifactRef = {
      ...htmlTile("inst-1"),
      htmlVersion: PINNED,
    };

    expect(parseTileRef(serializeTileRef(pinned))).toEqual(pinned);
  });

  it("restores a tile saved without a pin as Latest", () => {
    const restored = parseTileRef(serializeTileRef(htmlTile("inst-1")));

    expect(restored).toEqual(htmlTile("inst-1"));
    expect(restored).not.toHaveProperty("htmlVersion");
  });

  it("refuses a saved tile whose pin is damaged instead of reopening it on the live head", () => {
    const saved = serializeTileRef({
      ...htmlTile("inst-1"),
      htmlVersion: PINNED,
    });
    const damaged = {
      ...(saved as Record<string, unknown>),
      htmlVersion: { ...PINNED, entryPath: "missing.html" },
    };

    expect(parseTileRef(damaged)).toBeNull();
  });

  describe("selecting a version", () => {
    /** The opener's second view of one artifact: a distinct tab instance. */
    function twoTilesOfOnePage() {
      const first = openTile(
        createEmptyCanvas(),
        htmlTile("inst-1"),
        false,
        null,
      );
      if (first.root === null || first.root.kind !== "pane") {
        throw new Error("Expected a single pane.");
      }
      const state = openTileInPane(first, first.root.id, htmlTile("unused"), {
        mode: "permanent",
        index: null,
      });
      const secondId = Object.keys(state.tilesByInstanceId).find(
        (instanceId) => instanceId !== "inst-1",
      );
      if (secondId === undefined) throw new Error("Expected a second tile.");
      return { state, secondId };
    }

    it("pins only the tile it was chosen in, leaving a second tile of the same artifact on Latest", () => {
      const { state, secondId } = twoTilesOfOnePage();

      const next = updateHtmlArtifactVersion(state, "inst-1", PINNED);

      expect(next.tilesByInstanceId["inst-1"]).toMatchObject({
        htmlVersion: PINNED,
      });
      expect(next.tilesByInstanceId[secondId]).not.toHaveProperty(
        "htmlVersion",
      );
    });

    it("returns to Latest when the pin is cleared", () => {
      const pinned = updateHtmlArtifactVersion(
        twoTilesOfOnePage().state,
        "inst-1",
        PINNED,
      );
      const cleared = updateHtmlArtifactVersion(pinned, "inst-1", null);

      const tile = cleared.tilesByInstanceId["inst-1"];
      if (tile === undefined)
        throw new Error("Expected the tile to stay open.");
      // What a restart would restore: the live head again, not the old pin.
      expect(serializeTileRef(tile)).toEqual(
        serializeTileRef(htmlTile("inst-1")),
      );
    });

    it("leaves the state untouched when the tile is already on Latest", () => {
      const { state } = twoTilesOfOnePage();

      expect(updateHtmlArtifactVersion(state, "inst-1", null)).toBe(state);
    });
  });
});
