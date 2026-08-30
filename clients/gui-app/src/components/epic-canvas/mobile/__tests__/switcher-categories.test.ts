import { describe, expect, it } from "vitest";
import {
  clampToSwitcherCategory,
  isSwitcherCategory,
  visibleSwitcherCategoryDefs,
} from "@/components/epic-canvas/mobile/switcher-categories";
import { LEFT_PANEL_DEFINITIONS } from "@/components/epic-canvas/sidebar/left-panel-registry";

/**
 * Derived from the registry rather than restated, so the coupling is the test:
 * a panel added to the desktop rail and left off the phone bar fails here
 * instead of silently becoming a surface only a desktop can reach.
 */
const RAIL_PANEL_IDS = LEFT_PANEL_DEFINITIONS.map(
  (definition) => definition.id,
);

describe("switcher categories", () => {
  it("carries every desktop rail panel", () => {
    const visible = visibleSwitcherCategoryDefs(true).map(
      (definition) => definition.id,
    );
    expect([...visible].sort()).toEqual([...RAIL_PANEL_IDS].sort());
  });

  it("puts Browsers where the rail does, directly after Terminals", () => {
    const visible = visibleSwitcherCategoryDefs(true).map(
      (definition) => definition.id,
    );
    expect(visible.indexOf("browsers")).toBe(visible.indexOf("terminals") + 1);
  });

  it("reuses the rail's Browsers identity rather than forking the copy", () => {
    const bar = visibleSwitcherCategoryDefs(true).find(
      (definition) => definition.id === "browsers",
    );
    const rail = LEFT_PANEL_DEFINITIONS.find(
      (definition) => definition.id === "browsers",
    );
    expect(bar).toBe(rail);
  });

  it("keeps a persisted Browsers selection instead of clamping it to Agents", () => {
    expect(clampToSwitcherCategory("browsers", false)).toBe("browsers");
    expect(isSwitcherCategory("browsers")).toBe(true);
  });

  it("still drops Pull Requests on an epic with none", () => {
    const visible = visibleSwitcherCategoryDefs(false).map(
      (definition) => definition.id,
    );
    expect(visible).not.toContain("pull-requests");
    expect(visible).toContain("browsers");
  });
});
