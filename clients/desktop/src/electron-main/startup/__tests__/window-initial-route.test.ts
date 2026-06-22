import { describe, expect, it } from "vitest";
import type { PerWindowSnapshot } from "../../../ipc-contracts/window-types";
import { initialRouteForWindowSnapshot } from "../window-initial-route";

const EMPTY_SNAPSHOT: PerWindowSnapshot = {
  epicTabs: [],
  activeTabId: null,
  canvasByTabId: {},
  landingDrafts: [],
  activeLandingDraftId: null,
};

describe("initialRouteForWindowSnapshot", () => {
  it("restores the active epic tab when present", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        epicTabs: [
          { id: "tab-a", epicId: "epic-a", name: "Alpha" },
          { id: "tab-b", epicId: "epic-b", name: "Beta" },
        ],
        activeTabId: "tab-b",
      }),
    ).toBe("/epics/epic-b/tab-b");
  });

  it("restores the active landing draft when active epic and draft markers are both valid", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
        activeTabId: "tab-a",
        landingDrafts: [
          {
            id: "draft-a",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "draft-a",
      }),
    ).toBe("/draft/draft-a");
  });

  it("falls back to the active epic tab when the active landing draft is stale", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
        activeTabId: "tab-a",
        landingDrafts: [
          {
            id: "draft-a",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "missing-draft",
      }),
    ).toBe("/epics/epic-a/tab-a");
  });

  it("restores the active landing draft when no active epic tab exists", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        landingDrafts: [
          {
            id: "draft-a",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
          {
            id: "draft-b",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "draft-b",
      }),
    ).toBe("/draft/draft-b");
  });

  it("falls back to the active landing draft when the active epic tab is stale", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        epicTabs: [{ id: "tab-a", epicId: "epic-a", name: "Alpha" }],
        activeTabId: "missing-tab",
        landingDrafts: [
          {
            id: "draft-a",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "draft-a",
      }),
    ).toBe("/draft/draft-a");
  });

  it("falls back to the root entry only when no active epic tab or draft exists", () => {
    expect(initialRouteForWindowSnapshot(EMPTY_SNAPSHOT)).toBe("/");
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        landingDrafts: [
          {
            id: "draft-a",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "missing-draft",
      }),
    ).toBe("/");
  });

  it("encodes route segments", () => {
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        epicTabs: [{ id: "tab / one", epicId: "epic / one", name: "Alpha" }],
        activeTabId: "tab / one",
      }),
    ).toBe("/epics/epic%20%2F%20one/tab%20%2F%20one");
    expect(
      initialRouteForWindowSnapshot({
        ...EMPTY_SNAPSHOT,
        landingDrafts: [
          {
            id: "draft / one",
            content: { type: "doc" },
            selection: null,
            lastTouchedAt: 0,
            settings: null,
            composerMode: null,
            workspace: null,
          },
        ],
        activeLandingDraftId: "draft / one",
      }),
    ).toBe("/draft/draft%20%2F%20one");
  });
});
