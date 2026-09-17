import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  buildCmdkValue,
  paletteFilter,
} from "@/components/command-palette/palette-cmdk-controller";
import type { HistoryItem } from "@/components/home/data/home-page.data";
import type {
  HistoryFetchResult,
  UseHistoryQueryParams,
  UseHistoryQueryResult,
} from "@/hooks/home/use-history-query";
import {
  epicsSource,
  taskSearchQuery,
} from "@/lib/commands/sources/epics.source";
import { PaletteQueryProvider } from "@/lib/commands/palette-query-context";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";

const mockState = vi.hoisted(() => {
  return {
    recordedParams: [] as Array<UseHistoryQueryParams>,
    result: null as UseHistoryQueryResult | null,
  };
});

vi.mock("@/hooks/home/use-history-query", () => ({
  useHistoryQuery: (params: UseHistoryQueryParams): UseHistoryQueryResult => {
    mockState.recordedParams.push(params);
    const result = mockState.result;
    if (result === null) {
      throw new Error("mockState.result must be set before rendering");
    }
    return result;
  },
}));

function historyResult(
  items: ReadonlyArray<HistoryItem>,
): UseHistoryQueryResult {
  const data: HistoryFetchResult = {
    items,
    availableRepos: [],
    availableWorkspaces: [],
    totalCount: items.length,
    facets: {
      repos: [],
      workspaces: [],
      chatHosts: null,
      ownershipScopes: [],
    },
    worktreesByEpicId: new Map<string, readonly WorktreeHostEntryV12[]>(),
    chatHostFilterUnsupported: false,
    // `null` = the host made no completeness statement about this page, which
    // is the honest fixture value: the palette source under test never reads
    // it, so claiming a definite answer here would be inventing evidence.
    completeness: null,
    // The refused-initial-leg fixture is `true`; this suite's fixture is a
    // served page, so `false` is the honest value here too.
    hostRequiresCloudToList: false,
  };
  return {
    data,
    isPending: false,
    isFetching: false,
    error: null,
    hostId: "host-1",
    refetch: () => Promise.resolve(),
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    // Same reasoning as `completeness` above: the palette source never reads
    // it, so `false` is the quiet fixture rather than a claim that a cloud
    // page is settled.
    cloudPagePending: false,
  };
}

interface HistoryItemOverrides {
  readonly epicId: string;
  readonly title?: string;
  readonly pullRequestNumbers?: ReadonlyArray<string>;
  readonly worktreeBranches?: ReadonlyArray<string>;
  readonly linkedRepos?: ReadonlyArray<string>;
  readonly worktreePaths?: ReadonlyArray<string>;
}

function historyItem(overrides: HistoryItemOverrides): HistoryItem {
  return {
    id: `row:${overrides.epicId}`,
    epicId: overrides.epicId,
    taskType: "epic",
    title: overrides.title ?? "Untitled row",
    initialUserPrompt: "",
    updatedAtMs: 0,
    updatedLabel: "",
    updatedBucket: "today",
    linkedRepos: overrides.linkedRepos ?? [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: overrides.pullRequestNumbers ?? [],
    worktreeBranches: overrides.worktreeBranches ?? [],
    worktreePaths: overrides.worktreePaths ?? [],
    ownership: "mine",
    permissionRole: null,
    isPinned: false,
  };
}

function ctx(): CommandContext {
  return {
    pathname: "/",
    router: {
      getPathname: () => "/",
      navigateHome: () => undefined,
      navigateSettings: () => undefined,
      navigateToEpic: () => undefined,
      navigateToEpicTab: () => undefined,
      navigateToEpicList: () => undefined,
      navigateSettingsSection: () => undefined,
      navigateToTabIntent: () => undefined,
      goBack: () => undefined,
      goForward: () => undefined,
      isHistoryNavAvailable: () => false,
      canGoBack: () => false,
      canGoForward: () => false,
    },
    activeTabId: null,
    activeEpicId: null,
    focusedComposerKind: null,
    targetGroupId: null,
  };
}

function captureEpicsItems(query: string): ReadonlyArray<CommandItem> {
  let captured: ReadonlyArray<CommandItem> = [];
  function Probe() {
    captured = epicsSource.useItems(ctx());
    return null;
  }
  render(
    <PaletteQueryProvider value={query}>
      <Probe />
    </PaletteQueryProvider>,
  );
  return captured;
}

describe("taskSearchQuery", () => {
  it("passes a plain digit query through unchanged", () => {
    expect(taskSearchQuery("5186")).toBe("5186");
  });

  it("strips a leading Tasks scope prefix", () => {
    expect(taskSearchQuery("#5186")).toBe("5186");
  });

  it("strips the Tasks scope prefix and one following space", () => {
    expect(taskSearchQuery("# 5186")).toBe("5186");
  });

  it("hides the group for the Actions scope prefix", () => {
    expect(taskSearchQuery(">foo")).toBe("");
  });

  it("hides the group for the Workspaces scope prefix", () => {
    expect(taskSearchQuery("@ws")).toBe("");
  });

  it("trims a whitespace-only query to empty", () => {
    expect(taskSearchQuery("  ")).toBe("");
  });
});

describe("epicsSource", () => {
  beforeEach(() => {
    mockState.recordedParams.length = 0;
    mockState.result = historyResult([]);
  });

  afterEach(() => {
    cleanup();
    useEpicCanvasStore.setState({ tabsById: {}, openTabOrder: [] });
  });

  it("forwards a Tasks-scoped live query as relevance-sorted search text", () => {
    captureEpicsItems("#5186");
    const lastParams = mockState.recordedParams.at(-1);
    expect(lastParams).toBeDefined();
    expect(lastParams?.search.query).toBe("5186");
    expect(lastParams?.search.sort).toBe("relevance");
  });

  it("falls back to the default recents search when the live query is empty", () => {
    captureEpicsItems("");
    const lastParams = mockState.recordedParams.at(-1);
    expect(lastParams).toBeDefined();
    expect(lastParams?.search.query).toBe("");
    expect(lastParams?.search.sort).toBe("recent");
  });

  it("carries PR number / branch / repo match keywords on the emitted item", () => {
    const row = historyItem({
      epicId: "epic-pr-row",
      title: "Some unrelated title",
      pullRequestNumbers: ["5186", "#5186", "PR #5186"],
      worktreeBranches: ["traycer/clever-elk"],
      linkedRepos: ["traycerai/traycer-internal"],
    });
    mockState.result = historyResult([row]);

    const items = captureEpicsItems("#5186");
    const item = items.find((candidate) => candidate.id === "epic:epic-pr-row");
    expect(item).toBeDefined();
    if (item === undefined) throw new Error("item missing");

    for (const keyword of [
      "5186",
      "#5186",
      "PR #5186",
      "traycer/clever-elk",
      "traycerai/traycer-internal",
    ]) {
      expect(item.keywords).toContain(keyword);
    }
  });

  it("keeps the PR/branch-matched item alive under the palette's cmdk filter", () => {
    const row = historyItem({
      epicId: "epic-pr-row",
      title: "Some unrelated title",
      pullRequestNumbers: ["5186", "#5186", "PR #5186"],
      worktreeBranches: ["traycer/clever-elk"],
      linkedRepos: ["traycerai/traycer-internal"],
    });
    mockState.result = historyResult([row]);

    const items = captureEpicsItems("#5186");
    const item = items.find((candidate) => candidate.id === "epic:epic-pr-row");
    expect(item).toBeDefined();
    if (item === undefined) throw new Error("item missing");

    const value = buildCmdkValue(item);
    const keywords = [...item.keywords];
    expect(paletteFilter(value, "#5186", keywords)).toBeGreaterThan(0);
    expect(paletteFilter(value, "5186", keywords)).toBeGreaterThan(0);
    expect(paletteFilter(value, "clever-elk", keywords)).toBeGreaterThan(0);
  });

  it("keeps a row history matched only by its worktree path visible", () => {
    // A Traycer worktree directory is not the branch name - it carries a hash
    // suffix - so this query reaches the row through `worktreePaths` alone.
    // Without that keyword the task is fetched by the local arm and then
    // hidden by cmdk.
    const row = historyItem({
      epicId: "epic-path-row",
      title: "Some unrelated title",
      worktreeBranches: ["traycer/clever-elk"],
      worktreePaths: [
        "/Users/dev/.traycer/worktrees/traycer-clever-elk-7a9d867d6d1d",
      ],
    });
    mockState.result = historyResult([row]);

    const items = captureEpicsItems("7a9d867d6d1d");
    const item = items.find(
      (candidate) => candidate.id === "epic:epic-path-row",
    );
    expect(item).toBeDefined();
    if (item === undefined) throw new Error("item missing");

    expect(item.keywords).toContain(
      "/Users/dev/.traycer/worktrees/traycer-clever-elk-7a9d867d6d1d",
    );
    expect(
      paletteFilter(buildCmdkValue(item), "7a9d867d6d1d", [...item.keywords]),
    ).toBeGreaterThan(0);
  });

  it("ablation: a row without the match keywords scores 0 against the same query", () => {
    const row = historyItem({
      epicId: "epic-no-match",
      title: "Nothing related to the query at all",
    });
    mockState.result = historyResult([row]);

    const items = captureEpicsItems("#5186");
    const item = items.find(
      (candidate) => candidate.id === "epic:epic-no-match",
    );
    expect(item).toBeDefined();
    if (item === undefined) throw new Error("item missing");

    const value = buildCmdkValue(item);
    const keywords = [...item.keywords];
    expect(paletteFilter(value, "5186", keywords)).toBe(0);
  });

  it("open tab wins over its matching history row but inherits its match keywords", () => {
    const tab: EpicViewTab = { tabId: "tab-1", epicId: "e1", name: "Tab name" };
    useEpicCanvasStore.setState({
      tabsById: { "tab-1": tab },
      openTabOrder: ["tab-1"],
    });
    const row = historyItem({
      epicId: "e1",
      pullRequestNumbers: ["#5186", "5186", "PR #5186"],
    });
    mockState.result = historyResult([row]);

    const items = captureEpicsItems("#5186");
    const matches = items.filter((candidate) => candidate.id === "epic:e1");
    expect(matches).toHaveLength(1);
    const item = matches[0];
    expect(item.description).toBe("Open");
    expect(item.keywords).toContain("#5186");
  });

  it("an open tab with no matching history row still emits an Open item", () => {
    const tab: EpicViewTab = { tabId: "tab-2", epicId: "e2", name: "Solo tab" };
    useEpicCanvasStore.setState({
      tabsById: { "tab-2": tab },
      openTabOrder: ["tab-2"],
    });
    mockState.result = historyResult([]);

    const items = captureEpicsItems("");
    const item = items.find((candidate) => candidate.id === "epic:e2");
    expect(item).toBeDefined();
    if (item === undefined) throw new Error("item missing");
    expect(item.description).toBe("Open");
    expect(item.keywords).toEqual(["task", "epic", "open"]);
  });
});
