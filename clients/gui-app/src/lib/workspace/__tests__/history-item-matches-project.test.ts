import { describe, expect, it } from "vitest";
import {
  filterHistoryItemsForProject,
  historyItemMatchesProject,
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

  it("matches a fan-out chat via the documented Traycer worktree path", () => {
    expect(
      historyItemMatchesProject(
        item("fanout", [
          "/Users/g/.traycer/worktrees/gavasques__titanos/traycer-titanos-x",
          "/Users/g/.traycer/worktrees/gavasques__crm/traycer-crm-y",
        ], []),
        PROFILE,
      ),
    ).toBe(true);
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
