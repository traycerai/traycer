import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { HistoryItem } from "@/components/home/data/home-page.data";

/**
 * `useHistoryOpenItem` is what "open this task" means for every History list.
 * A task whose `epic.batchDelete` is still in flight does not open from any of
 * them: the open raced the host's delete.
 *
 * The in-flight answer is the REAL `useEpicDeleteInFlightReader` over a real
 * `QueryClient`, with the delete staged as a held mutation under the dispatch's
 * own key. What is faked is where an open lands: the router, the command action
 * an Epic opens through, and the activation boundary a Phase opens through.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn<(destination: unknown) => Promise<void>>(),
  openEpicFromList: vi.fn<
    (
      navigate: unknown,
      epicId: string,
      pathname: string,
      options: {
        readonly title: string | undefined;
        readonly source: string;
      },
    ) => void
  >(),
  activateTabIntent:
    vi.fn<(navigate: unknown, intent: unknown, options: unknown) => void>(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => mocks.navigate,
  useRouterState: (options: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => options.select({ location: { pathname: "/epics" } }),
}));

vi.mock("@/lib/commands/actions/open-epic-from-list", () => ({
  openEpicFromList: mocks.openEpicFromList,
}));

vi.mock("@/lib/tab-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tab-navigation")>()),
  activateTabIntent: mocks.activateTabIntent,
}));

import { useHistoryOpenItem } from "@/components/epics/use-history-open-item";
import { holdEpicBatchDelete } from "@/hooks/epic/__tests__/hold-epic-batch-delete";

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id: "history-epic-1",
    epicId: "epic-a",
    taskType: "epic",
    title: "Open from landing",
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
    recentAtMs: 1_700_000_000_000,
    recentLabel: "about 2 hours ago",
    recentBucket: "today",
    linkedRepos: [],
    linkedWorkspaces: [],
    chatHostIds: null,
    pullRequestNumbers: [],
    worktreeBranches: [],
    worktreePaths: [],
    ownership: "mine",
    permissionRole: "owner",
    isPinned: false,
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderOpenItem(args: {
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
}) {
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useHistoryOpenItem(args), { wrapper });
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.navigate.mockResolvedValue(undefined);
  mocks.openEpicFromList.mockReset();
  mocks.activateTabIntent.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
});

describe("useHistoryOpenItem while a task's deletion is in flight", () => {
  it("hands the item to a destination picker when nothing is being deleted", () => {
    const onOpenItem = vi.fn<(item: HistoryItem) => void>();
    const item = historyItem({});
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem });

    result.current(item);

    expect(onOpenItem).toHaveBeenCalledWith(item);
  });

  it("opens neither through a destination picker nor by selecting the epic", () => {
    const onOpenItem = vi.fn<(item: HistoryItem) => void>();
    const onSelectEpic = vi.fn<(epicId: string) => void>();
    void holdEpicBatchDelete(queryClient, ["epic-a"]);
    const { result: pickerResult } = renderOpenItem({
      onSelectEpic: null,
      onOpenItem,
    });
    const { result: navigatingResult } = renderOpenItem({
      onSelectEpic,
      onOpenItem: null,
    });

    pickerResult.current(historyItem({}));
    navigatingResult.current(historyItem({}));

    expect(onOpenItem).not.toHaveBeenCalled();
    // The overlay-closing hook runs only on a real open, so a refused open
    // leaves History where it is.
    expect(onSelectEpic).not.toHaveBeenCalled();
    expect(mocks.openEpicFromList).not.toHaveBeenCalled();
    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens an epic through the command action when nothing is being deleted", () => {
    const onSelectEpic = vi.fn<(epicId: string) => void>();
    const { result } = renderOpenItem({ onSelectEpic, onOpenItem: null });

    result.current(historyItem({ epicId: "epic-a", title: "Alpha" }));

    expect(onSelectEpic).toHaveBeenCalledWith("epic-a");
    expect(mocks.openEpicFromList).toHaveBeenCalledTimes(1);
    expect(mocks.openEpicFromList.mock.calls.at(0)?.slice(1)).toEqual([
      "epic-a",
      "/epics",
      { title: "Alpha", source: "direct_ui" },
    ]);
  });

  it("opens a phase through the activation boundary when nothing is being deleted", () => {
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem: null });

    result.current(historyItem({ epicId: "phase-a", taskType: "phase" }));

    expect(mocks.activateTabIntent).toHaveBeenCalledTimes(1);
    expect(mocks.openEpicFromList).not.toHaveBeenCalled();
  });

  it("refuses a phase whose id is being deleted", () => {
    void holdEpicBatchDelete(queryClient, ["phase-a"]);
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem: null });

    result.current(historyItem({ epicId: "phase-a", taskType: "phase" }));

    expect(mocks.activateTabIntent).not.toHaveBeenCalled();
  });

  it("still opens a different task while another is being deleted", () => {
    const onOpenItem = vi.fn<(item: HistoryItem) => void>();
    void holdEpicBatchDelete(queryClient, ["epic-a"]);
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem });
    const other = historyItem({ id: "history-epic-2", epicId: "epic-b" });

    result.current(other);

    expect(onOpenItem).toHaveBeenCalledWith(other);
  });

  it("refuses when any one pending batch names the task, among several", () => {
    const onOpenItem = vi.fn<(item: HistoryItem) => void>();
    void holdEpicBatchDelete(queryClient, ["epic-x"]);
    void holdEpicBatchDelete(queryClient, ["epic-y", "epic-a"]);
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem });

    result.current(historyItem({}));

    expect(onOpenItem).not.toHaveBeenCalled();
  });

  // The gate is asked when the open is attempted, not when the list rendered:
  // the SAME function, kept from before the delete began, refuses after it has
  // begun and opens again once it has ended.
  it("answers for the moment of the open, not the render the function came from", async () => {
    const onOpenItem = vi.fn<(item: HistoryItem) => void>();
    const { result } = renderOpenItem({ onSelectEpic: null, onOpenItem });
    const open = result.current;
    const item = historyItem({});

    open(item);
    expect(onOpenItem).toHaveBeenCalledTimes(1);

    const held = holdEpicBatchDelete(queryClient, ["epic-a"]);
    open(item);
    expect(onOpenItem).toHaveBeenCalledTimes(1);

    await act(async () => {
      await held.settle();
    });
    open(item);
    expect(onOpenItem).toHaveBeenCalledTimes(2);
  });
});
