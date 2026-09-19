import type { HistoryItem } from "@/components/home/data/home-page.data";
import type { CurrentTaskGroups } from "@/lib/home/current-tasks";
import type { ActivityFleetCoverage } from "@/stores/agent-activity-store";

const testState = vi.hoisted(() => ({
  groups: { inProgress: [], pinned: [], open: [] } as CurrentTaskGroups,
  isPending: false,
  pinsComplete: true,
  activityCoverage: "fleet" as ActivityFleetCoverage,
  openItem: vi.fn<(item: HistoryItem) => void>(),
  openHistory: vi.fn(),
  setPinnedMutate: vi.fn<(variables: SetPinnedVariables) => void>(),
  pendingPinIds: new Set<string>(),
}));

const pinSupport = vi.hoisted(() =>
  vi.fn<(hostId: string | null) => boolean>(),
);

interface SetPinnedVariables {
  readonly epicId: string;
  readonly pinned: boolean;
  readonly isLocalHome: boolean;
  readonly hostId: string | null;
}

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("@/hooks/notifications/use-host-notification-indicators-query", () => ({
  useHostNotificationIndicators: () => ({
    data: { epics: {}, chats: {} },
    isPending: false,
    isFetching: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

vi.mock("@/hooks/home/use-current-tasks", () => ({
  useCurrentTasks: () => ({
    groups: testState.groups,
    isPending: testState.isPending,
    pinsComplete: testState.pinsComplete,
    activityCoverage: testState.activityCoverage,
  }),
}));

vi.mock("@/components/epics/use-history-open-item", () => ({
  useHistoryOpenItem: () => testState.openItem,
}));

vi.mock("@/hooks/epic/use-epic-set-pinned-mutation", () => ({
  useEpicSetPinned: () => ({ mutate: testState.setPinnedMutate }),
  usePendingSetPinnedEpicIds: () => testState.pendingPinIds,
}));

vi.mock("@/hooks/epic/use-epic-pin-local-home-support", () => ({
  useEpicPinLocalHomeSupported: (hostId: string | null) => pinSupport(hostId),
}));

vi.mock("@/hooks/epic/use-epic-activity-status", () => ({
  useEpicActivityStatus: () => "idle",
}));

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: () => null,
}));

vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({ openHistory: testState.openHistory }),
}));

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentTasksSection } from "@/components/home/current-tasks-section";
import { DEFAULT_HISTORY_SEARCH } from "@/lib/history-search";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useHistorySearchStore } from "@/stores/home/history-search-store";

const CAPTION =
  "Tasks in progress, pinned, or open in a tab. Everything else is in History.";
const COVERAGE_NOTICE = "Can't check everything that's running right now";
const PINS_UNAVAILABLE_NOTICE = "Can't load your pinned tasks right now.";
const PINS_PARTIAL_NOTICE = "Some pinned tasks couldn't load.";

function task(id: string, overrides: Partial<HistoryItem>): HistoryItem {
  return {
    id,
    epicId: `epic-${id}`,
    taskType: "epic",
    title: `Task ${id}`,
    initialUserPrompt: "",
    updatedAtMs: 1_700_000_000_000,
    updatedLabel: "about 2 hours ago",
    updatedBucket: "today",
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

function tasks(prefix: string, count: number): HistoryItem[] {
  return Array.from({ length: count }, (_, index) =>
    task(`${prefix}${index + 1}`, {}),
  );
}

function setGroups(groups: Partial<CurrentTaskGroups>): void {
  testState.groups = { inProgress: [], pinned: [], open: [], ...groups };
}

function renderSection() {
  return render(<CurrentTasksSection />);
}

function rowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-current-task-id]"),
  ).map((row) => row.dataset.currentTaskId ?? "");
}

function rowButton(id: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(
    `[data-current-task-id="${id}"]`,
  );
  if (row === null) throw new Error(`no row for ${id}`);
  return row;
}

function group(title: string): HTMLElement {
  return screen.getByRole("region", { name: new RegExp(`^${title}`) });
}

describe("<CurrentTasksSection />", () => {
  beforeEach(() => {
    setGroups({});
    testState.isPending = false;
    testState.pinsComplete = true;
    testState.activityCoverage = "fleet";
    testState.openItem.mockReset();
    testState.openHistory.mockReset();
    testState.setPinnedMutate.mockReset();
    testState.pendingPinIds = new Set();
    pinSupport.mockReset();
    pinSupport.mockReturnValue(true);
    useAuthStore.setState({ status: "signed-in" });
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  afterEach(() => {
    cleanup();
    useAuthStore.setState({ status: "signed-out" });
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  describe("content", () => {
    it("renders the heading, View history and the three groups", () => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("c", {})],
      });
      renderSection();

      const section = screen.getByTestId("current-tasks-section");
      expect(
        within(section).getByRole("heading", { name: "Current tasks" }),
      ).not.toBeNull();
      expect(within(section).queryByText(CAPTION)).toBeNull();
      expect(
        within(section).getByRole("button", { name: /^View history/ }),
      ).not.toBeNull();
      expect(group("In progress")).not.toBeNull();
      expect(group("Pinned")).not.toBeNull();
      expect(group("Open")).not.toBeNull();
      expect(rowIds()).toEqual(["a", "b", "c"]);
    });

    it("opens History from View history", () => {
      renderSection();

      // Confirmed-empty also carries its own View history; the header's is first.
      fireEvent.click(
        screen.getAllByRole("button", { name: /^View history/ })[0],
      );

      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it("omits empty groups", () => {
      setGroups({ pinned: [task("b", { isPinned: true })] });
      renderSection();

      expect(screen.queryByRole("region", { name: /^In progress/ })).toBeNull();
      expect(screen.queryByRole("region", { name: /^Open/ })).toBeNull();
      expect(group("Pinned")).not.toBeNull();
    });

    it("opens a task from its row target", () => {
      const item = task("a", {});
      setGroups({ open: [item] });
      renderSection();

      fireEvent.click(screen.getByRole("button", { name: "Open task Task a" }));

      expect(testState.openItem).toHaveBeenCalledWith(item);
    });

    it("offers only open and pin: no rename, delete, sweep or select", () => {
      setGroups({ open: [task("a", {})] });
      renderSection();

      expect(
        screen.getByRole("button", { name: "Open task Task a" }),
      ).not.toBeNull();
      expect(screen.getByTestId("epics-list-row-pin")).not.toBeNull();
      expect(screen.queryByTestId("epics-list-row-rename")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-delete")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-sweep")).toBeNull();
      expect(screen.queryByTestId("epics-list-row-sweep-disabled")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /select|delete|rename/i }),
      ).toBeNull();
    });

    it("pins and unpins through the shared mutation", () => {
      setGroups({
        pinned: [task("b", { isPinned: true })],
        open: [task("a", {})],
      });
      renderSection();

      fireEvent.click(within(rowItem("a")).getByTestId("epics-list-row-pin"));
      fireEvent.click(within(rowItem("b")).getByTestId("epics-list-row-pin"));

      expect(testState.setPinnedMutate).toHaveBeenNthCalledWith(1, {
        epicId: "epic-a",
        pinned: true,
        isLocalHome: false,
        hostId: null,
      });
      expect(testState.setPinnedMutate).toHaveBeenNthCalledWith(2, {
        epicId: "epic-b",
        pinned: false,
        isLocalHome: false,
        hostId: null,
      });
    });

    it("propagates a local-homed row's isLocalHome to the pin mutation", () => {
      setGroups({ open: [task("a", { isLocalHome: true })] });
      renderSection();

      fireEvent.click(screen.getByTestId("epics-list-row-pin"));

      expect(testState.setPinnedMutate).toHaveBeenCalledWith({
        epicId: "epic-a",
        pinned: true,
        isLocalHome: true,
        hostId: null,
      });
    });

    it("disables the pin control of a task whose pin is in flight", () => {
      testState.pendingPinIds = new Set(["epic-a"]);
      setGroups({ open: [task("a", {})] });
      renderSection();

      const pin = screen.getByTestId("epics-list-row-pin");
      expect(pin instanceof HTMLButtonElement && pin.disabled).toBe(true);
    });

    it("dispatches a pin against the row's owning host", () => {
      setGroups({ open: [task("a", { hostId: "host-b", isLocalHome: true })] });
      renderSection();

      fireEvent.click(screen.getByTestId("epics-list-row-pin"));

      expect(pinSupport).toHaveBeenCalledWith("host-b");
      expect(testState.setPinnedMutate).toHaveBeenCalledWith({
        epicId: "epic-a",
        pinned: true,
        isLocalHome: true,
        hostId: "host-b",
      });
    });

    it("gates a local row on its owning host: unsupported there is aria-disabled and never dispatches", () => {
      pinSupport.mockImplementation((hostId) => hostId !== "host-b");
      setGroups({
        open: [
          task("a", { hostId: "host-b", isLocalHome: true }),
          task("c", { hostId: "host-d", isLocalHome: true }),
        ],
      });
      renderSection();

      const pinA = within(rowItem("a")).getByTestId("epics-list-row-pin");
      const pinC = within(rowItem("c")).getByTestId("epics-list-row-pin");
      expect(pinA.getAttribute("aria-disabled")).toBe("true");
      expect(pinC.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(pinA);
      expect(testState.setPinnedMutate).not.toHaveBeenCalled();
      fireEvent.click(pinC);
      expect(testState.setPinnedMutate).toHaveBeenCalledTimes(1);
    });
  });

  describe("History query independence", () => {
    it("does not change when a History query changes", () => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("c", {})],
      });
      const { container } = renderSection();
      const before = container.innerHTML;

      act(() => {
        useHistorySearchStore.setState({
          search: { ...DEFAULT_HISTORY_SEARCH, query: "no such task" },
        });
      });

      expect(container.innerHTML).toBe(before);
      expect(rowIds()).toEqual(["a", "b", "c"]);
    });
  });

  describe("empty and loading states", () => {
    interface Case {
      readonly isPending: boolean;
      readonly pinsComplete: boolean;
      readonly coverage: ActivityFleetCoverage;
    }
    const COVERAGES: readonly ActivityFleetCoverage[] = [
      "fleet",
      "partial",
      "none",
    ];
    const cases: Case[] = [];
    for (const isPending of [false, true]) {
      for (const pinsComplete of [true, false]) {
        for (const coverage of COVERAGES) {
          cases.push({ isPending, pinsComplete, coverage });
        }
      }
    }

    it.each(cases)(
      "claims 'No current tasks' only when settled, pins complete and fleet coverage: $isPending / $pinsComplete / $coverage",
      ({ isPending, pinsComplete, coverage }) => {
        testState.isPending = isPending;
        testState.pinsComplete = pinsComplete;
        testState.activityCoverage = coverage;
        renderSection();

        const claimsEmpty = screen.queryByText("No current tasks") !== null;

        expect(claimsEmpty).toBe(
          !isPending && pinsComplete && coverage === "fleet",
        );
        expect(
          screen.getByRole("heading", { name: "Current tasks" }),
        ).not.toBeNull();
        expect(screen.queryByText(CAPTION)).toBeNull();
      },
    );

    it("shows the empty state with a View history action when confirmed empty", () => {
      renderSection();

      expect(screen.getByText("No current tasks")).not.toBeNull();
      const emptyState = screen.getByText("No current tasks").parentElement;
      if (emptyState === null) throw new Error("expected empty state");
      fireEvent.click(
        within(emptyState).getByRole("button", { name: "View history" }),
      );
      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it("shows the standard loader while a fleet-covered, empty list is pending", () => {
      testState.isPending = true;
      renderSection();

      expect(screen.getByTestId("epics-list-loading")).not.toBeNull();
      expect(screen.queryByText("No current tasks")).toBeNull();
      expect(screen.queryByText(COVERAGE_NOTICE)).toBeNull();
    });

    it("does not show the loader once there are rows, even while pending", () => {
      testState.isPending = true;
      setGroups({ open: [task("a", {})] });
      renderSection();

      expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      expect(rowIds()).toEqual(["a"]);
    });

    it.each<ActivityFleetCoverage>(["partial", "none"])(
      "shows the muted coverage line in In progress for %s coverage, even while pending",
      (coverage) => {
        testState.activityCoverage = coverage;
        testState.isPending = true;
        renderSection();

        const inProgress = group("In progress");
        expect(within(inProgress).getByText(COVERAGE_NOTICE)).not.toBeNull();
        expect(screen.getByTestId("epics-list-loading")).not.toBeNull();
        expect(screen.queryByText("No current tasks")).toBeNull();
      },
    );

    it("keeps the coverage line above the rows in In progress", () => {
      testState.activityCoverage = "partial";
      setGroups({ inProgress: [task("a", {})] });
      renderSection();

      const inProgress = group("In progress");
      expect(within(inProgress).getByText(COVERAGE_NOTICE)).not.toBeNull();
      expect(
        within(inProgress).getByRole("button", { name: "Open task Task a" }),
      ).not.toBeNull();
    });

    it("explains the blank with zero rows, fleet coverage and incomplete pins, and never claims empty", () => {
      testState.pinsComplete = false;
      renderSection();

      expect(
        screen.getByRole("heading", { name: "Current tasks" }),
      ).not.toBeNull();
      expect(screen.queryByText(CAPTION)).toBeNull();
      expect(
        within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
      ).not.toBeNull();
      expect(screen.queryByText("No current tasks")).toBeNull();
      expect(screen.queryByText(COVERAGE_NOTICE)).toBeNull();
      expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      expect(rowIds()).toEqual([]);
      // View history stays reachable from the header.
      fireEvent.click(screen.getByRole("button", { name: /^View history/ }));
      expect(testState.openHistory).toHaveBeenCalledTimes(1);
    });

    it.each<ActivityFleetCoverage>(["partial", "none"])(
      "shows the pins line beside the activity line for %s coverage when settled with incomplete pins",
      (coverage) => {
        testState.pinsComplete = false;
        testState.activityCoverage = coverage;
        renderSection();

        expect(
          within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
        ).not.toBeNull();
        expect(
          within(group("In progress")).getByText(COVERAGE_NOTICE),
        ).not.toBeNull();
        expect(screen.queryByText("No current tasks")).toBeNull();
        expect(screen.queryByTestId("epics-list-loading")).toBeNull();
      },
    );

    it("with pinned rows and incomplete pins, shows the partial line once, after the pinned rows", () => {
      testState.pinsComplete = false;
      setGroups({ pinned: [task("p1", {}), task("p2", {})] });
      renderSection();

      const notice = within(group("Pinned")).getByText(PINS_PARTIAL_NOTICE);
      expect(screen.getAllByText(PINS_PARTIAL_NOTICE)).toHaveLength(1);
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
      expect(rowIds()).toEqual(["p1", "p2"]);
      expect(
        rowButton("p2").compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("shows the 'none' copy, not the partial one, when only other groups have rows and pins are incomplete", () => {
      testState.pinsComplete = false;
      setGroups({ open: [task("o1", {})] });
      renderSection();

      expect(
        within(group("Pinned")).getByText(PINS_UNAVAILABLE_NOTICE),
      ).not.toBeNull();
      expect(screen.queryByText(PINS_PARTIAL_NOTICE)).toBeNull();
      expect(rowIds()).toEqual(["o1"]);
    });

    it("does not show the pins line while pins are still loading or when they are complete", () => {
      testState.pinsComplete = false;
      testState.isPending = true;
      const view = renderSection();
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
      view.unmount();

      testState.pinsComplete = true;
      testState.isPending = false;
      testState.activityCoverage = "partial";
      renderSection();
      expect(screen.queryByText(PINS_UNAVAILABLE_NOTICE)).toBeNull();
    });
  });

  describe("group caps", () => {
    it("shows five rows per group and a 'Show N more' for each group independently", () => {
      setGroups({
        inProgress: tasks("i", 7),
        pinned: tasks("p", 6),
        open: tasks("o", 9),
      });
      renderSection();

      expect(
        within(group("In progress")).getAllByRole("listitem"),
      ).toHaveLength(5);
      expect(within(group("Pinned")).getAllByRole("listitem")).toHaveLength(5);
      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(5);
      expect(
        screen.getByRole("button", { name: "Show 2 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 1 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 4 more" }),
      ).not.toBeNull();
    });

    it("expands only the group whose 'Show N more' was pressed", () => {
      setGroups({
        inProgress: tasks("i", 7),
        pinned: tasks("p", 6),
        open: tasks("o", 9),
      });
      renderSection();

      fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));

      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(9);
      expect(
        within(group("In progress")).getAllByRole("listitem"),
      ).toHaveLength(5);
      expect(within(group("Pinned")).getAllByRole("listitem")).toHaveLength(5);
      expect(screen.queryByRole("button", { name: "Show 4 more" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 2 more" }),
      ).not.toBeNull();
      expect(
        screen.getByRole("button", { name: "Show 1 more" }),
      ).not.toBeNull();
    });

    it("offers no 'Show more' for a group of exactly five", () => {
      setGroups({ open: tasks("o", 5) });
      renderSection();

      expect(
        screen.queryByRole("button", { name: /Show \d+ more/ }),
      ).toBeNull();
      expect(within(group("Open")).getAllByRole("listitem")).toHaveLength(5);
    });
  });

  describe("keyboard", () => {
    beforeEach(() => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
        open: [task("d", {})],
      });
    });

    it("never takes focus on mount", () => {
      renderSection();

      expect(document.activeElement).toBe(document.body);
    });

    it("ArrowDown moves through rows in visual order across groups", () => {
      renderSection();
      act(() => rowButton("a").focus());

      for (const expected of ["b", "c", "d"]) {
        fireEvent.keyDown(focused(), { key: "ArrowDown" });
        expect(document.activeElement).toBe(rowButton(expected));
      }
    });

    it("ArrowDown on the last row stays put", () => {
      renderSection();
      act(() => rowButton("d").focus());

      fireEvent.keyDown(rowButton("d"), { key: "ArrowDown" });

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("ArrowUp moves backwards across groups", () => {
      renderSection();
      act(() => rowButton("d").focus());

      for (const expected of ["c", "b", "a"]) {
        fireEvent.keyDown(focused(), { key: "ArrowUp" });
        expect(document.activeElement).toBe(rowButton(expected));
      }
    });

    it("ArrowUp on the first row stays put", () => {
      renderSection();
      act(() => rowButton("a").focus());

      fireEvent.keyDown(rowButton("a"), { key: "ArrowUp" });

      expect(document.activeElement).toBe(rowButton("a"));
    });

    it("ignores other keys", () => {
      renderSection();
      act(() => rowButton("a").focus());

      fireEvent.keyDown(rowButton("a"), { key: "ArrowRight" });
      fireEvent.keyDown(rowButton("a"), { key: "Tab" });

      expect(document.activeElement).toBe(rowButton("a"));
    });
  });

  describe("focus repair", () => {
    const viewHistory = () =>
      screen.getAllByRole("button", { name: /^View history/ })[0];

    beforeEach(() => {
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
        open: [task("d", {})],
      });
    });

    it("moves focus to the next surviving row when the focused row is removed", () => {
      const view = renderSection();
      act(() => rowButton("b").focus());

      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("c", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
    });

    it("falls back to the previous surviving row when nothing follows", () => {
      const view = renderSection();
      act(() => rowButton("d").focus());

      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true }), task("c", { isPinned: true })],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
    });

    it("skips consecutive removed rows to the next survivor", () => {
      const view = renderSection();
      act(() => rowButton("b").focus());

      setGroups({
        inProgress: [task("a", {})],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("lands on View history when the last row disappears", () => {
      setGroups({ open: [task("d", {})] });
      const view = renderSection();
      act(() => rowButton("d").focus());

      setGroups({});
      testState.pinsComplete = false;
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(viewHistory());
    });

    it("follows a focused pin that is unpinned out of the section", () => {
      const view = renderSection();
      act(() => rowButton("c").focus());

      // Unpinning removes the row from Pinned; it is not open either.
      setGroups({
        inProgress: [task("a", {})],
        pinned: [task("b", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("d"));
    });

    it("keeps focus on a row that moves to another group", () => {
      const view = renderSection();
      act(() => rowButton("c").focus());

      // `c` starts working: it leaves Pinned for In progress.
      setGroups({
        inProgress: [task("a", {}), task("c", { isPinned: true })],
        pinned: [task("b", { isPinned: true })],
        open: [task("d", {})],
      });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(rowButton("c"));
      expect(
        within(group("In progress")).getByRole("button", {
          name: "Open task Task c",
        }),
      ).not.toBeNull();
    });

    it("does not steal focus that is elsewhere when a row disappears", () => {
      const view = renderSection();
      const outside = document.createElement("button");
      document.body.append(outside);
      act(() => outside.focus());

      setGroups({ inProgress: [task("a", {})] });
      view.rerender(<CurrentTasksSection />);

      expect(document.activeElement).toBe(outside);
      outside.remove();
    });
  });
});

function focused(): HTMLElement {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) throw new Error("nothing is focused");
  return active;
}

function rowItem(id: string): HTMLElement {
  const item = rowButton(id).closest("li");
  if (item === null) throw new Error(`no list item for ${id}`);
  return item;
}
