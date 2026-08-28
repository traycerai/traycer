import { afterEach, describe, expect, it } from "vitest";
import { sanitizePersistedCanvasState } from "@/stores/epics/canvas/canvas-persistence";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

describe("canvas Phase-migration persistence", () => {
  it("restores the persisted slot-local migration mode", () => {
    const state = sanitizePersistedCanvasState({
      tabsById: {
        "phase-tab": {
          tabId: "phase-tab",
          epicId: "phase-1",
          name: "Legacy Phase",
          surfaceMode: { kind: "phase-migration", phaseId: "phase-1" },
        },
      },
      canvasByTabId: {},
      openTabOrder: ["phase-tab"],
      activeTabId: "phase-tab",
      mostRecentTabIdByEpicId: { "phase-1": "phase-tab" },
      artifactTreeByEpicId: {},
    });

    expect(state.tabsById["phase-tab"]?.surfaceMode).toEqual({
      kind: "phase-migration",
      phaseId: "phase-1",
    });
  });
});

describe("canvas PiP geometry persistence", () => {
  afterEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("keeps anchored geometry and drops malformed entries", () => {
    const state = sanitizePersistedCanvasState({
      tabsById: {},
      pipGeometryByEpicId: {
        "epic-good": {
          anchorX: 332,
          anchorY: 224,
          previewWidth: 320,
          previewHeight: 200,
        },
        "epic-string": {
          anchorX: "332",
          anchorY: 224,
          previewWidth: 320,
          previewHeight: 200,
        },
        "epic-nan": {
          anchorX: Number.NaN,
          anchorY: 224,
          previewWidth: 320,
          previewHeight: 200,
        },
        "epic-missing": { anchorX: 332, anchorY: 224, previewWidth: 320 },
        "epic-not-object": "nope",
      },
    });

    expect(state.pipGeometryByEpicId).toEqual({
      "epic-good": {
        anchorX: 332,
        anchorY: 224,
        previewWidth: 320,
        previewHeight: 200,
      },
    });
  });

  it("setPipGeometry writes pipGeometryByEpicId", () => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useEpicCanvasStore.getState().setPipGeometry("epic-1", {
      anchorX: 360,
      anchorY: 280,
      previewWidth: 320,
      previewHeight: 200,
    });
    expect(useEpicCanvasStore.getState().pipGeometryByEpicId["epic-1"]).toEqual(
      {
        anchorX: 360,
        anchorY: 280,
        previewWidth: 320,
        previewHeight: 200,
      },
    );
  });
});
