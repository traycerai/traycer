import { describe, expect, it } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import type { RestorableWindowEntry } from "../../windows/desktop-state-store";
import { planActivateWithoutLiveWindow } from "../activate-window-plan";

function snapshot(patch: Partial<PerWindowSnapshot>): PerWindowSnapshot {
  return {
    epicTabs: [],
    activeTabId: null,
    canvasByTabId: {},
    landingDrafts: [],
    activeLandingDraftId: null,
    ...patch,
  };
}

function entry(
  windowId: string,
  patch: Partial<PerWindowSnapshot>,
): RestorableWindowEntry {
  return { windowId, snapshot: snapshot(patch) };
}

describe("planActivateWithoutLiveWindow", () => {
  it("mints a blank window when there are no restorable entries", () => {
    expect(planActivateWithoutLiveWindow([])).toEqual({ kind: "create-blank" });
  });

  it("mints a blank window when the only entries carry no tabs or drafts", () => {
    expect(planActivateWithoutLiveWindow([entry("window-a", {})])).toEqual({
      kind: "create-blank",
    });
  });

  it("restores a window preserved with open epic tabs (macOS red-light-close then activate)", () => {
    const preserved = entry("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    expect(planActivateWithoutLiveWindow([preserved])).toEqual({
      kind: "restore",
      entries: [preserved],
    });
  });

  it("restores a window preserved with only landing drafts", () => {
    const preserved = entry("window-a", {
      landingDrafts: [
        {
          id: "draft-a",
          content: {},
          selection: null,
          lastTouchedAt: 0,
          settings: null,
          composerMode: null,
          workspace: null,
        },
      ],
      activeLandingDraftId: "draft-a",
    });
    expect(planActivateWithoutLiveWindow([preserved])).toEqual({
      kind: "restore",
      entries: [preserved],
    });
  });

  it("restores only the content-bearing entries and drops empty ones", () => {
    const withTabs = entry("window-a", {
      epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
      activeTabId: "tab-a",
    });
    const empty = entry("window-b", {});
    expect(planActivateWithoutLiveWindow([withTabs, empty])).toEqual({
      kind: "restore",
      entries: [withTabs],
    });
  });
});
