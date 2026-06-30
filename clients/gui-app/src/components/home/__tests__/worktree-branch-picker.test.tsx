import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { Key, ReactNode } from "react";

const mockVirtuosoState = vi.hoisted(() => ({
  includeTransientUndefinedRow: false,
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  interface MockVirtuosoHandle {
    readonly scrollIntoView: (location: unknown) => void;
    readonly scrollToIndex: (location: unknown) => void;
    readonly scrollBy: (location: unknown) => void;
    readonly scrollTo: (location: unknown) => void;
  }

  interface MockVirtuosoProps {
    readonly className?: string;
    readonly data?: ReadonlyArray<unknown>;
    readonly computeItemKey?: (index: number, item: unknown) => Key;
    readonly initialTopMostItemIndex?:
      number | { readonly index: number | "LAST" };
    readonly itemContent?: (index: number, item: unknown) => ReactNode;
  }

  const Virtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(
    (props, ref) => {
      React.useImperativeHandle(ref, () => ({
        scrollBy: () => undefined,
        scrollIntoView: () => undefined,
        scrollTo: () => undefined,
        scrollToIndex: () => undefined,
      }));

      const data = props.data ?? [];
      const indexes = mockVirtuosoIndexes(
        data.length,
        mockInitialIndex(props.initialTopMostItemIndex, data.length),
      );
      const renderedIndexes = mockVirtuosoState.includeTransientUndefinedRow
        ? [...indexes, data.length]
        : indexes;
      return React.createElement(
        "div",
        {
          className: props.className,
          "data-testid": "virtuoso-scroller",
        },
        ...renderedIndexes.map((index) =>
          React.createElement(
            React.Fragment,
            {
              key: props.computeItemKey?.(index, data[index]) ?? index,
            },
            props.itemContent?.(index, data[index]),
          ),
        ),
      );
    },
  );

  function mockInitialIndex(
    value: MockVirtuosoProps["initialTopMostItemIndex"],
    totalCount: number,
  ): number {
    if (totalCount === 0) return 0;
    let rawIndex = 0;
    if (typeof value === "number") {
      rawIndex = value;
    } else if (value?.index === "LAST") {
      rawIndex = totalCount - 1;
    } else if (value?.index !== undefined) {
      rawIndex = value.index;
    }
    if (rawIndex < 0) return 0;
    if (rawIndex >= totalCount) return totalCount - 1;
    return rawIndex;
  }

  function mockVirtuosoIndexes(
    totalCount: number,
    initialIndex: number,
  ): ReadonlyArray<number> {
    const windowSize = 12;
    const start = Math.max(0, initialIndex - Math.floor(windowSize / 2));
    const end = Math.min(totalCount, start + windowSize);
    return Array.from(
      { length: end - start },
      (_unused, index) => start + index,
    );
  }

  return { Virtuoso };
});

import {
  WorktreeBranchPicker,
  type WorktreeBranchPickerAction,
  type WorktreeBranchPickerPinnedRow,
  type WorktreeBranchPickerRow,
} from "@/components/home/worktree/worktree-branch-picker";
import {
  pathSearchBasename,
  pathSearchTail,
} from "@/components/home/data/worktree-branch-search";
import { TooltipProvider } from "@/components/ui/tooltip";

function branchRow(
  value: string,
  branch: string,
  path: string,
  selected: boolean,
): WorktreeBranchPickerRow {
  return {
    id: value,
    value,
    primaryLabel: branch,
    secondaryLabel: path,
    secondaryTitle: path,
    badges: [],
    selected,
    disabled: false,
    disabledReason: null,
    testId: `branch-row-${value}`,
    searchBranch: branch,
    searchPathTail: pathSearchTail(path),
    searchPathBasename: pathSearchBasename(path),
    searchFullPath: path,
  };
}

function pinnedLocal(onSelect: () => void): WorktreeBranchPickerPinnedRow {
  return {
    id: "local",
    value: "local",
    primaryLabel: "main",
    secondaryLabel: "/repo/main",
    secondaryTitle: "/repo/main",
    badges: ["dirty"],
    selected: true,
    disabled: false,
    disabledReason: null,
    testId: "branch-row-local",
    onSelect,
  };
}

function createAction(onSelect: () => void): WorktreeBranchPickerAction {
  return {
    id: "create",
    label: "Create new worktree…",
    icon: <span aria-hidden>+</span>,
    selected: false,
    disabled: false,
    disabledReason: null,
    testId: "branch-action-create",
    onSelect,
  };
}

function renderPicker(
  rows: ReadonlyArray<WorktreeBranchPickerRow>,
  onSelectRow: (row: WorktreeBranchPickerRow) => void,
): void {
  render(
    <TooltipProvider>
      <WorktreeBranchPicker
        align="start"
        side="bottom"
        defaultOpen={false}
        searchPlaceholder="Search branches"
        listboxLabel="Branches"
        emptyLabel="No branches"
        contentClassName={undefined}
        portalContainer={null}
        rows={rows}
        pinnedRows={[pinnedLocal(() => undefined)]}
        actions={[createAction(() => undefined)]}
        onSelectRow={onSelectRow}
        trigger={<button type="button">Open branches</button>}
      />
    </TooltipProvider>,
  );
}

describe("<WorktreeBranchPicker />", () => {
  afterEach(() => {
    mockVirtuosoState.includeTransientUndefinedRow = false;
    cleanup();
    vi.restoreAllMocks();
  });

  it("focuses search on open and keeps pinned/action rows visible during search", async () => {
    renderPicker(
      [
        branchRow("alpha", "feature/alpha", "/repo/worktrees/alpha", false),
        branchRow("beta", "feature/beta", "/repo/worktrees/beta", false),
      ],
      () => undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open branches" }));
    const input = await screen.findByLabelText("Search branches");

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    fireEvent.change(input, { target: { value: "beta" } });

    expect(screen.getByTestId("branch-row-local")).not.toBeNull();
    expect(screen.getByText("dirty")).not.toBeNull();
    expect(screen.getByTestId("branch-action-create")).not.toBeNull();
    expect(screen.getByText("feature/beta")).not.toBeNull();
    expect(screen.queryByText("feature/alpha")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Branches" }).querySelector("[title]"),
    ).toBeNull();
  });

  it("supports keyboard navigation and Enter selection from search results", async () => {
    const selectedValues: string[] = [];
    renderPicker(
      [
        branchRow("alpha", "feature/alpha", "/repo/worktrees/alpha", false),
        branchRow("beta", "feature/beta", "/repo/worktrees/beta", false),
      ],
      (row) => selectedValues.push(row.value),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open branches" }));
    const input = await screen.findByLabelText("Search branches");
    fireEvent.change(input, { target: { value: "betaa" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(selectedValues).toEqual(["beta"]);
  });

  it("opens a virtualized list around a far-down selected row", async () => {
    const rows = Array.from({ length: 60 }, (_unused, index) =>
      branchRow(
        `branch-${index + 1}`,
        `feature/branch-${index + 1}`,
        `/repo/worktrees/branch-${index + 1}`,
        index === 44,
      ),
    );
    renderPicker(rows, () => undefined);

    fireEvent.click(screen.getByRole("button", { name: "Open branches" }));

    expect(await screen.findByText("feature/branch-45")).not.toBeNull();
  });

  it("tolerates transient undefined row data from Virtuoso", async () => {
    mockVirtuosoState.includeTransientUndefinedRow = true;
    renderPicker(
      [
        branchRow("alpha", "feature/alpha", "/repo/worktrees/alpha", false),
        branchRow("beta", "feature/beta", "/repo/worktrees/beta", false),
      ],
      () => undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open branches" }));

    expect(await screen.findByText("feature/alpha")).not.toBeNull();
    expect(screen.getByText("feature/beta")).not.toBeNull();
  });

  it("does not restore focus to the trigger after selecting a row", async () => {
    const selectedValues: string[] = [];
    renderPicker(
      [
        branchRow("alpha", "feature/alpha", "/repo/worktrees/alpha", false),
        branchRow("beta", "feature/beta", "/repo/worktrees/beta", false),
      ],
      (row) => selectedValues.push(row.value),
    );

    const trigger = screen.getByRole("button", { name: "Open branches" });
    fireEvent.click(trigger);
    await screen.findByLabelText("Search branches");
    fireEvent.click(screen.getByTestId("branch-row-beta"));

    await waitFor(() => {
      expect(selectedValues).toEqual(["beta"]);
    });
    expect(document.activeElement).not.toBe(trigger);
  });
});
