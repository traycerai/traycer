import { describe, expect, it } from "vitest";
import { parseHistorySearch } from "@/lib/history-search";
import { listCloudTasksRequestForHistorySearch } from "@/lib/cloud-epic-tasks-query";

describe("listCloudTasksRequestForHistorySearch", () => {
  it("builds a type-safe server request from typed history search state", () => {
    const search = parseHistorySearch({
      historyQuery: "api",
      historyRepos: ["traycer/gui-app", "invalid/repo/label"],
      historyRepoMode: "all",
      historyWorkspaces: ["host-1:%2FUsers%2Fme%2Fgui-app"],
      historyWorkspaceMode: "all",
      historyOwnership: ["mine"],
      historySort: "title-asc",
    });

    expect(listCloudTasksRequestForHistorySearch(search)).toMatchObject({
      limit: 20,
      sort: "title-asc",
      filters: {
        query: "api",
        repoIdentifiers: [{ owner: "traycer", repo: "gui-app" }],
        repoMatchMode: "all",
        workspaceIdentifiers: [
          {
            hostId: "host-1",
            workspacePath: "/Users/me/gui-app",
          },
        ],
        workspaceMatchMode: "all",
        ownershipScopes: ["mine"],
      },
    });
  });
});
