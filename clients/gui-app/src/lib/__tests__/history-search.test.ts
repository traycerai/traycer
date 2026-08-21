import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_SEARCH,
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
      chatHosts: [],
      chatHostMode: "any",
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

  it("round-trips the last-viewed sort", () => {
    const search = parseHistorySearch({ historySort: "last-viewed" });

    expect(search.sort).toBe("last-viewed");
    expect(historySearchToParams(search)).toMatchObject({
      historySort: "last-viewed",
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
  it("round-trips chat-host selections through the URL, dropping a default mode", () => {
    const parsed = parseHistorySearch({
      historyChatHosts: ["host-b", "host-a"],
      historyChatHostMode: "all",
    });
    // Sorted on parse so two URLs naming the same hosts in different orders
    // produce the same state - and therefore the same query key.
    expect(parsed.chatHosts).toEqual(["host-a", "host-b"]);
    expect(parsed.chatHostMode).toBe("all");
    expect(historySearchToParams(parsed)).toMatchObject({
      historyChatHosts: ["host-a", "host-b"],
      historyChatHostMode: "all",
    });

    // A single host cannot have a match mode worth serializing, and "any" is
    // the default - neither belongs in the URL.
    const single = patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
      chatHosts: ["host-a"],
      chatHostMode: "all",
    });
    expect(historySearchToParams(single).historyChatHostMode).toBeUndefined();
    const defaulted = patchHistorySearch(DEFAULT_HISTORY_SEARCH, {
      chatHosts: ["host-a", "host-b"],
    });
    expect(
      historySearchToParams(defaulted).historyChatHostMode,
    ).toBeUndefined();
  });

  it("collapses whitespace variants of one chat-host id to a single entry", () => {
    // Deduping raw values first would let `" host-a "` and `"host-a"` both
    // survive and then trim into the same id, serializing it twice.
    const parsed = parseHistorySearch({
      historyChatHosts: ["host-a", " host-a ", "host-a  "],
    });
    expect(parsed.chatHosts).toEqual(["host-a"]);
    expect(historySearchToParams(parsed).historyChatHosts).toEqual(["host-a"]);
    // One id, so no match mode belongs in the URL either.
    expect(historySearchToParams(parsed).historyChatHostMode).toBeUndefined();
  });

  it("drops blank chat-host ids and clears the params", () => {
    expect(
      parseHistorySearch({ historyChatHosts: ["", "  ", "host-a"] }).chatHosts,
    ).toEqual(["host-a"]);
    expect(
      clearHistorySearchParams({
        historyChatHosts: ["host-a"],
        historyChatHostMode: "all",
        keep: 1,
      }),
    ).toEqual({ keep: 1 });
  });
});
