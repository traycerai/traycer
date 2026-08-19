import { describe, expect, it } from "vitest";
import {
  filterHistoryItemsForProject,
  historyItemMatchesProject,
  historyListEmptyState,
} from "../history-item-matches-project";
import type { ProjectProfile } from "@/stores/workspace/project-profiles-store";

const PROFILE: ProjectProfile = {
  id: "p1",
  name: "Titanos",
  color: "orange",
  folderPaths: ["/Users/g/work/Titanos"],
  primaryPath: "/Users/g/work/Titanos",
  epicIds: ["claimed"],
};

function item(
  epicId: string,
  worktreePaths: ReadonlyArray<string>,
  linkedWorkspaces: ReadonlyArray<string>,
): {
  readonly epicId: string;
  readonly worktreePaths: ReadonlyArray<string>;
  readonly linkedWorkspaces: ReadonlyArray<{
    readonly hostId: string;
    readonly workspacePath: string;
  }>;
} {
  return {
    epicId,
    worktreePaths,
    linkedWorkspaces: linkedWorkspaces.map((workspacePath) => ({
      hostId: "host-a",
      workspacePath,
    })),
  };
}

describe("historyItemMatchesProject", () => {
  it("matches an explicitly claimed epic", () => {
    expect(historyItemMatchesProject(item("claimed", [], []), PROFILE)).toBe(
      true,
    );
  });

  it("does not match a fan-out chat that also has another project's worktree", () => {
    expect(
      historyItemMatchesProject(
        item("fanout", [
          "/Users/g/.traycer/worktrees/gavasques__titanos/traycer-titanos-x",
          "/Users/g/.traycer/worktrees/gavasques__crm/traycer-crm-y",
        ], []),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("matches a Titanos-only chat via the documented Traycer worktree path", () => {
    expect(
      historyItemMatchesProject(
        item(
          "titanos-only",
          ["/Users/g/.traycer/worktrees/gavasques__titanos/traycer-titanos-x"],
          [],
        ),
        PROFILE,
      ),
    ).toBe(true);
  });

  it("does not match a fan-out chat that also linked another folder", () => {
    expect(
      historyItemMatchesProject(
        item(
          "fanout-linked",
          [],
          ["/Users/g/work/Titanos", "/Users/g/work/CRM"],
        ),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("does not match a claimed chat that also has another project's folder", () => {
    expect(
      historyItemMatchesProject(
        item("claimed", [], ["/Users/g/work/CRM"]),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("matches a local-mode chat by its originating workspace path", () => {
    expect(
      historyItemMatchesProject(
        item("local", [], ["/Users/g/work/Titanos"]),
        PROFILE,
      ),
    ).toBe(true);
  });

  it("does not match an unclaimed chat with no worktrees and no workspace", () => {
    expect(historyItemMatchesProject(item("empty", [], []), PROFILE)).toBe(
      false,
    );
  });

  it("does not match another folder that only shares the basename", () => {
    expect(
      historyItemMatchesProject(
        item(
          "clone",
          [
            "/Users/g/.traycer/worktrees/gavasques__titanos/traycer-titanos-x",
          ],
          ["/Users/g/personal/Titanos"],
        ),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("does not match a path that merely contains the folder name", () => {
    expect(
      historyItemMatchesProject(
        item("substring", ["/Users/g/not-titanos/src"], ["/Users/g/not-titanos"]),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("matches a Windows worktree path against a Windows project folder", () => {
    const windowsProfile: ProjectProfile = {
      ...PROFILE,
      folderPaths: ["C:\\Users\\g\\work\\Titanos"],
      primaryPath: "C:\\Users\\g\\work\\Titanos",
      epicIds: [],
    };
    expect(
      historyItemMatchesProject(
        item("win", [
          "C:\\Users\\g\\.traycer\\worktrees\\gavasques__titanos\\traycer-titanos-x",
        ], []),
        windowsProfile,
      ),
    ).toBe(true);
  });

  it("matches a Windows originating workspace regardless of slash style", () => {
    const windowsProfile: ProjectProfile = {
      ...PROFILE,
      folderPaths: ["C:/Users/g/work/Titanos"],
      primaryPath: "C:/Users/g/work/Titanos",
      epicIds: [],
    };
    expect(
      historyItemMatchesProject(
        item("win-local", [], ["C:\\Users\\g\\work\\Titanos"]),
        windowsProfile,
      ),
    ).toBe(true);
  });

  it("matches equivalent Windows paths that differ only in casing", () => {
    const windowsProfile: ProjectProfile = {
      ...PROFILE,
      folderPaths: ["C:\\Users\\g\\work\\Titanos"],
      primaryPath: "C:\\Users\\g\\work\\Titanos",
      epicIds: [],
    };
    expect(
      historyItemMatchesProject(
        item("win-case", [], ["c:\\users\\g\\work\\titanos"]),
        windowsProfile,
      ),
    ).toBe(true);
  });

  it("matches equivalent UNC paths that differ only in casing", () => {
    const uncProfile: ProjectProfile = {
      ...PROFILE,
      folderPaths: ["\\\\Fileserver\\Repos\\Titanos"],
      primaryPath: "\\\\Fileserver\\Repos\\Titanos",
      epicIds: [],
    };
    expect(
      historyItemMatchesProject(
        item("unc-case", [], ["\\\\FILESERVER\\repos\\titanos"]),
        uncProfile,
      ),
    ).toBe(true);
  });

  it("does not treat POSIX paths as case-insensitive", () => {
    expect(
      historyItemMatchesProject(
        item("posix-case", [], ["/Users/g/work/titanos"]),
        PROFILE,
      ),
    ).toBe(false);
  });

  it("does not match a chat that never touched the project folder", () => {
    expect(
      historyItemMatchesProject(
        item("other", [
          "/Users/g/.traycer/worktrees/gavasques__crm/traycer-crm-y",
        ], []),
        PROFILE,
      ),
    ).toBe(false);
  });
});

describe("filterHistoryItemsForProject", () => {
  it("keeps the full list when no profile is active", () => {
    const items = [item("a", [], [])];
    expect(filterHistoryItemsForProject(items, null)).toBe(items);
  });
});

describe("historyListEmptyState", () => {
  it("returns null while rows are visible", () => {
    expect(
      historyListEmptyState({
        visibleCount: 2,
        preProjectFilterCount: 5,
        hasActiveFilters: false,
        projectFilterActive: true,
      }),
    ).toBeNull();
  });

  it("points at All projects when the active project hides every chat", () => {
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 5,
        hasActiveFilters: false,
        projectFilterActive: true,
      }),
    ).toBe("hidden-by-active-project");
  });

  it("points at All projects when search matches exist only outside the project", () => {
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 3,
        hasActiveFilters: true,
        projectFilterActive: true,
      }),
    ).toBe("hidden-by-active-project");
  });

  it("keeps the plain empty copy when the project truly has no chats anywhere", () => {
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 0,
        hasActiveFilters: false,
        projectFilterActive: true,
      }),
    ).toBe("no-tasks");
  });

  it("keeps the plain empty copy when no project is active", () => {
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 0,
        hasActiveFilters: false,
        projectFilterActive: false,
      }),
    ).toBe("no-tasks");
  });

  it("keeps the filter empty copy when nothing matches the search", () => {
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 0,
        hasActiveFilters: true,
        projectFilterActive: true,
      }),
    ).toBe("no-filter-matches");
    expect(
      historyListEmptyState({
        visibleCount: 0,
        preProjectFilterCount: 0,
        hasActiveFilters: true,
        projectFilterActive: false,
      }),
    ).toBe("no-filter-matches");
  });
});
