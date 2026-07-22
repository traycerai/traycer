import { describe, expect, it } from "vitest";
import { sanitizePersistedCanvasState } from "@/stores/epics/canvas/canvas-persistence";

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
