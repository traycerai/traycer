import { describe, expect, it } from "vitest";
import {
  filterHeaderStripItemIdsForProject,
  headerTabMatchesProject,
  headerTabProjectBadge,
  historyItemProjectBadge,
  resolveEpicWorkspaceHint,
  resolveOwningProjectProfile,
  stampedWorkspaceHintForEpic,
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

const CRM: ProjectProfile = {
  id: "p-crm",
  name: "CRM",
  color: "blue",
  folderPaths: ["/Users/g/work/CRM"],
  primaryPath: "/Users/g/work/CRM",
  epicIds: ["claimed-crm"],
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

  it("hides a fan-out epic whose primary folder is not this project", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "issue-1180" }, TITANOS, {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/Traycer" },
          { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
        ],
      }),
    ).toBe(false);
  });

  it("hides a fan-out epic even when Titanos is first in the folder list", () => {
    expect(
      headerTabMatchesProject({ kind: "epic", epicId: "issue-1180" }, TITANOS, {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
          { hostId: "host-a", workspacePath: "/Users/g/work/Traycer" },
        ],
        primaryPath: "/Users/g/work/Titanos",
      }),
    ).toBe(false);
  });

  it("hides a claimed epic whose primary folder belongs to another project", () => {
    expect(
      headerTabMatchesProject(
        { kind: "epic", epicId: "claimed-titanos" },
        TITANOS,
        {
          worktreePaths: [],
          linkedWorkspaces: [
            { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
          ],
        },
      ),
    ).toBe(false);
  });
});

describe("resolveOwningProjectProfile", () => {
  const profiles = [TITANOS, CRM];

  it("returns the profile only when every workspace folder is inside it", () => {
    expect(
      resolveOwningProjectProfile(profiles, "any-epic", {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
        ],
      }),
    ).toEqual(CRM);
  });

  it("returns null when the epic also has folders outside that profile", () => {
    expect(
      resolveOwningProjectProfile(profiles, "any-epic", {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
          { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
        ],
      }),
    ).toBeNull();
  });

  it("returns the claimed profile when the epic has no workspace", () => {
    expect(resolveOwningProjectProfile(profiles, "claimed-titanos", null)).toEqual(
      TITANOS,
    );
  });

  it("returns null when no profile owns the epic", () => {
    expect(
      resolveOwningProjectProfile(profiles, "orphan", {
        worktreePaths: [],
        linkedWorkspaces: [
          { hostId: "host-a", workspacePath: "/Users/g/work/Traycer" },
        ],
      }),
    ).toBeNull();
  });
});

describe("headerTabProjectBadge", () => {
  it("hides the color while a project is active", () => {
    expect(headerTabProjectBadge(TITANOS, CRM)).toBeNull();
  });

  it("shows the owning color only on All projects", () => {
    expect(headerTabProjectBadge(null, CRM)).toEqual({
      color: "blue",
      name: "CRM",
    });
  });
});

describe("historyItemProjectBadge", () => {
  const profiles = [TITANOS, CRM];
  const titanosOnly = {
    epicId: "old-titanos",
    worktreePaths: [] as const,
    linkedWorkspaces: [
      { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
    ],
  };
  const fanOut = {
    epicId: "issue-1180",
    worktreePaths: [] as const,
    linkedWorkspaces: [
      { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
      { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
    ],
  };

  it("puts Titanos color and name on an owned History row in All projects", () => {
    expect(historyItemProjectBadge(null, profiles, titanosOnly)).toEqual({
      color: "orange",
      name: "Titanos",
    });
  });

  it("hides the History badge while a project is active", () => {
    expect(historyItemProjectBadge(TITANOS, profiles, titanosOnly)).toBeNull();
  });

  it("hides the History badge on a fan-out row with no single owner", () => {
    expect(historyItemProjectBadge(null, profiles, fanOut)).toBeNull();
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

  it("keeps a path-owned tab when only the persisted stamp is present", () => {
    expect(
      filterHeaderStripItemIdsForProject({
        itemIds: items.map((item) => item.id),
        items,
        profile: TITANOS,
        epicIdForTabId: (tabId) => {
          if (tabId === "tab-t") return "old-titanos";
          if (tabId === "tab-c") return "crm";
          return null;
        },
        workspaceHintForEpic: (epicId) =>
          resolveEpicWorkspaceHint({
            live: null,
            stamped: stampedWorkspaceHintForEpic(
              {
                "tab-t": {
                  epicId: "old-titanos",
                  projectWorkspace: {
                    worktreePaths: [],
                    linkedWorkspaces: [
                      {
                        hostId: "host-a",
                        workspacePath: "/Users/g/work/Titanos",
                      },
                    ],
                    primaryPath: "/Users/g/work/Titanos",
                  },
                },
                "tab-c": {
                  epicId: "crm",
                  projectWorkspace: {
                    worktreePaths: [],
                    linkedWorkspaces: [
                      {
                        hostId: "host-a",
                        workspacePath: "/Users/g/work/CRM",
                      },
                    ],
                    primaryPath: "/Users/g/work/CRM",
                  },
                },
              },
              epicId,
            ),
          }),
      }),
    ).toEqual(["tab:epic:titanos", "tab:draft:home"]);
  });
});

describe("resolveEpicWorkspaceHint", () => {
  const stamped = {
    worktreePaths: [],
    linkedWorkspaces: [
      { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
    ],
    primaryPath: "/Users/g/work/Titanos",
  };
  const live = {
    worktreePaths: [],
    linkedWorkspaces: [
      { hostId: "host-a", workspacePath: "/Users/g/work/CRM" },
    ],
    primaryPath: "/Users/g/work/CRM",
  };

  it("uses the live session folders when they exist", () => {
    expect(resolveEpicWorkspaceHint({ live, stamped })).toEqual(live);
  });

  it("uses the stamped folders when the session is cold", () => {
    expect(resolveEpicWorkspaceHint({ live: null, stamped })).toEqual(stamped);
  });

  it("ignores an empty live peek instead of wiping the stamp", () => {
    expect(
      resolveEpicWorkspaceHint({
        live: { worktreePaths: [], linkedWorkspaces: [] },
        stamped,
      }),
    ).toEqual(stamped);
  });
});

describe("stampedWorkspaceHintForEpic", () => {
  it("reads the stamp from any tab of that epic", () => {
    expect(
      stampedWorkspaceHintForEpic(
        {
          "tab-a": {
            epicId: "old-titanos",
            projectWorkspace: {
              worktreePaths: [],
              linkedWorkspaces: [
                { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
              ],
              primaryPath: "/Users/g/work/Titanos",
            },
          },
        },
        "old-titanos",
      ),
    ).toEqual({
      worktreePaths: [],
      linkedWorkspaces: [
        { hostId: "host-a", workspacePath: "/Users/g/work/Titanos" },
      ],
      primaryPath: "/Users/g/work/Titanos",
    });
  });

  it("returns null when no tab of that epic has a stamp", () => {
    expect(
      stampedWorkspaceHintForEpic(
        { "tab-a": { epicId: "old-titanos" } },
        "old-titanos",
      ),
    ).toBeNull();
  });
});
