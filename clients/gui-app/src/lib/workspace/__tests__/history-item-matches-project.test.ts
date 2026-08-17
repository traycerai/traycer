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
  folderPaths: ["/Users/g/Titanos"],
  primaryPath: "/Users/g/Titanos",
  epicIds: ["claimed"],
};

function item(
  epicId: string,
  worktreePaths: ReadonlyArray<string>,
): { readonly epicId: string; readonly worktreePaths: ReadonlyArray<string> } {
  return { epicId, worktreePaths };
}

describe("historyItemMatchesProject", () => {
  it("matches an explicitly claimed epic", () => {
    expect(historyItemMatchesProject(item("claimed", []), PROFILE)).toBe(true);
  });

  it("matches a fan-out chat that still has a worktree under the project", () => {
    expect(
      historyItemMatchesProject(
        item("fanout", [
          "/Users/g/.traycer/worktrees/gavasques__titanos/traycer-titanos-x",
          "/Users/g/.traycer/worktrees/gavasques__crm/traycer-crm-y",
        ]),
        PROFILE,
      ),
    ).toBe(true);
  });

  it("does not match a chat that never touched the project folder", () => {
    expect(
      historyItemMatchesProject(
        item("other", [
          "/Users/g/.traycer/worktrees/gavasques__crm/traycer-crm-y",
        ]),
        PROFILE,
      ),
    ).toBe(false);
  });
});

describe("filterHistoryItemsForProject", () => {
  it("keeps the full list when no profile is active", () => {
    const items = [item("a", [])];
    expect(filterHistoryItemsForProject(items, null)).toBe(items);
  });
});
