import { describe, expect, it } from "vitest";
import {
  clearHistorySearchParams,
  historySearchToParams,
  parseHistorySearch,
  patchHistorySearch,
} from "@/lib/history-search";

describe("history search params", () => {
  it("parses typed history params and defaults active search to relevance", () => {
    const search = parseHistorySearch({
      historyQuery: "  api  ",
      historyRepos: ["traycer/server", " traycer/gui-app "],
      historyRepoMode: "all",
      historyWorkspaces: [
        "host-1:%2FUsers%2Fme%2Fgui-app",
        "host-1:%2FUsers%2Fme%2Fgui-app",
      ],
      historyWorkspaceMode: "all",
      historyOwnership: "shared",
    });

    expect(search).toEqual({
      query: "  api  ",
      repos: ["traycer/gui-app", "traycer/server"],
      repoMode: "all",
      workspaces: [{ hostId: "host-1", workspacePath: "/Users/me/gui-app" }],
      workspaceMode: "all",
      ownershipScopes: ["shared"],
      sort: "relevance",
      sortExplicit: false,
    });
  });

  it("preserves an explicit recent sort while a query is active", () => {
    const querySearch = parseHistorySearch({ historyQuery: "api" });
    const search = patchHistorySearch(querySearch, {
      sort: "recent",
      sortExplicit: true,
    });

    expect(historySearchToParams(search)).toMatchObject({
      historyQuery: "api",
      historySort: "recent",
    });
  });

  it("clears only history params and keeps unrelated route search state", () => {
    expect(
      clearHistorySearchParams({
        focusedAt: 1,
        historyQuery: "api",
        historyRepos: ["traycer/gui-app"],
        historyRepoMode: "all",
        historyWorkspaces: ["host-1:%2FUsers%2Fme%2Fgui-app"],
        historyWorkspaceMode: "all",
        historyOwnership: ["mine"],
        historySort: "relevance",
      }),
    ).toEqual({ focusedAt: 1 });
  });
});
