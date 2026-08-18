import { describe, expect, it } from "vitest";
import {
  filterHeaderStripItemIdsForProject,
  headerTabMatchesProject,
} from "../header-tab-matches-project";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";
import type { StripItem } from "@/stores/tabs/layout";

const TITANOS: ProjectProfile = {
  id: "p-titanos",
  name: "Titanos",
  color: "orange",
  folderPaths: ["/Users/g/work/Titanos"],
  primaryPath: "/Users/g/work/Titanos",
  epicIds: ["claimed-titanos"],
};

describe("headerTabMatchesProject", () => {
  it("keeps every tab when All projects is active", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "crm" }, null, null),
    ).toBe(true);
  });

  it("keeps settings, history, and draft tabs on a project", () => {
    expect(headerTabMatchesProject({ kind: "settings" }, TITANOS, null)).toBe(
      true,
    );
    expect(headerTabMatchesProject({ kind: "history" }, TITANOS, null)).toBe(
      true,
    );
    expect(headerTabMatchesProject({ kind: "draft" }, TITANOS, null)).toBe(true);
  });

  it("keeps a claimed epic on that project", () => {
    expect(
      headerTabMatchesProject(
        { kind: "epic", epicId: "claimed-titanos" },
        TITANOS,
        null,
      ),
    ).toBe(true);
  });

  it("keeps an unclaimed epic whose workspace is the project folder", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "old-titanos" }, TITANOS, {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
        ],
      }),
    ).toBe(true);
  });

  it("hides an unclaimed epic from another folder", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "crm" }, TITANOS, {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
        ],
      }),
    ).toBe(false);
  });

  it("hides an unclaimed epic with no workspace hint", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "unknown" }, TITANOS, null),
    ).toBe(false);
  });
});

describe("filterHeaderStripItemIdsForProject", () => {
  const items: ReadonlyArray<StripItem> = [
    { kind: "tab", id: "tab:epic:titanos", ref: { kind: "epic", id: "tab-t" } },
    { kind: "tab", id: "tab:epic:crm", ref: { kind: "epic", id: "tab-c" } },
    { kind: "tab", id: "tab:draft:home", ref: { kind: "draft", id: "draft-1" } },
  ];

  it("hides a foreign epic tab and keeps the landing draft", () => {
    expect(
      filterHeaderStripItemIdsForProject({
        itemIds: items.map((item) => item.id),
        items,
        profile: TITANOS,
        epicIdForTabId: (tabId) => {
          if (tabId === "tab-t") return "claimed-titanos";
          if (tabId === "tab-c") return "crm";
          return null;
        },
        workspaceHintForEpic: () => null,
      }),
    ).toEqual(["tab:epic:titanos", "tab:draft:home"]);
  });

  it("hides a split that mixes this project with another", () => {
    const splitItems: ReadonlyArray<StripItem> = [
      {
        kind: "split",
        id: "split:mix",
        left: { kind: "tab", ref: { kind: "epic", id: "tab-t" } },
        right: { kind: "tab", ref: { kind: "epic", id: "tab-c" } },
        focusedSide: "left",
        routeBackingSide: "left",
        leftRatio: 0.5,
      },
    ];
    expect(
      filterHeaderStripItemIdsForProject({
        itemIds: ["split:mix"],
        items: splitItems,
        profile: TITANOS,
        epicIdForTabId: (tabId) => {
          if (tabId === "tab-t") return "claimed-titanos";
          if (tabId === "tab-c") return "crm";
          return null;
        },
        workspaceHintForEpic: () => null,
      }),
    ).toEqual([]);
  });
});
