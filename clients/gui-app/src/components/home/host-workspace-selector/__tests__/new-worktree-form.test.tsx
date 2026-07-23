import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { StrictMode, useState, type Key, type ReactNode } from "react";
import type {
  WorktreeFolderIntent,
  WorktreeWorkspaceSummary,
} from "@traycer/protocol/host/worktree-schemas";
import { TooltipProvider } from "@/components/ui/tooltip";
import * as worktreeBranchSearch from "@/components/home/data/worktree-branch-search";
import * as worktreeBranchPickerOptions from "@/components/home/worktree/worktree-branch-picker-options";

// Drive the form's model from a fixed listBranches payload, no live host.
let branchesData:
  | {
      readonly branches: ReadonlyArray<{
        readonly name: string;
        readonly isCurrent: boolean;
        readonly isRemoteOnly: boolean;
      }>;
      readonly uncommittedFileCount: number;
    }
  | undefined;
let branchesLoading = false;

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: branchesData, isLoading: branchesLoading }),
}));

const mockVirtuosoState = vi.hoisted(() => ({
  captureConfiguration: vi.fn(),
  scrollIntoView: vi.fn(),
  transientUndefinedIndexes: new Set<number>(),
  /**
   * When true, scrollIntoView does not apply centerIndex / call `done` until
   * `flushPendingScroll()` runs. Models a lagging virtual window for ARIA tests.
   */
  delayedScroll: false,
  pendingScrollApply: null as null | (() => void),
  flushPendingScroll(): void {
    const apply = mockVirtuosoState.pendingScrollApply;
    mockVirtuosoState.pendingScrollApply = null;
    apply?.();
  },
}));

vi.mock("react-virtuoso", async () => {
  const React = await import("react");

  interface MockScrollLocation {
    readonly index: number;
    readonly behavior: "auto" | "smooth";
    readonly done?: () => void;
  }

  interface MockVirtuosoHandle {
    readonly scrollIntoView: (location: MockScrollLocation) => void;
    readonly scrollToIndex: (location: unknown) => void;
    readonly scrollBy: (location: unknown) => void;
    readonly scrollTo: (location: unknown) => void;
  }

  interface MockVirtuosoProps {
    readonly id?: string;
    readonly role?: string;
    readonly "aria-label"?: string;
    readonly "data-testid"?: string;
    readonly className?: string;
    readonly tabIndex?: number;
    readonly context?: unknown;
    readonly data?: ReadonlyArray<unknown>;
    readonly defaultItemHeight?: number;
    readonly increaseViewportBy?: number;
    readonly initialItemCount?: number;
    readonly computeItemKey?: (index: number, item: unknown) => Key;
    readonly initialTopMostItemIndex?:
      number | { readonly index: number | "LAST" };
    readonly rangeChanged?: (range: {
      readonly startIndex: number;
      readonly endIndex: number;
    }) => void;
    readonly itemContent?: (
      index: number,
      item: unknown,
      context: unknown,
    ) => ReactNode;
  }

  const Virtuoso = React.forwardRef<MockVirtuosoHandle, MockVirtuosoProps>(
    (props, ref) => {
      const data = props.data ?? [];
      mockVirtuosoState.captureConfiguration({
        defaultItemHeight: props.defaultItemHeight,
        increaseViewportBy: props.increaseViewportBy,
        initialItemCount: props.initialItemCount,
      });
      const initialIndex = mockInitialIndex(
        props.initialTopMostItemIndex,
        data.length,
      );
      const [centerIndex, setCenterIndex] = React.useState(initialIndex);
      const pendingDoneRef = React.useRef<(() => void) | null>(null);
      const rangeChangedRef = React.useRef(props.rangeChanged);
      rangeChangedRef.current = props.rangeChanged;

      React.useImperativeHandle(ref, () => ({
        scrollBy: () => undefined,
        scrollIntoView: (location) => {
          mockVirtuosoState.scrollIntoView(location);
          const apply = (): void => {
            pendingDoneRef.current = location.done ?? null;
            setCenterIndex((prev) => {
              // Same center: React bails out so layout-effect won't re-run.
              // Fire done immediately — the target is already in the mounted
              // window (Virtuoso's "immediate if no scroll" contract).
              if (prev === location.index) {
                const done = pendingDoneRef.current;
                pendingDoneRef.current = null;
                done?.();
                return prev;
              }
              return location.index;
            });
          };
          if (mockVirtuosoState.delayedScroll) {
            // Latest scroll wins; drop any earlier pending apply so tests can
            // flush a single mid-scroll window update.
            mockVirtuosoState.pendingScrollApply = apply;
            return;
          }
          apply();
        },
        scrollTo: () => undefined,
        scrollToIndex: () => undefined,
      }));

      const indexes = mockVirtuosoIndexes(
        data.length,
        centerIndex,
        props.initialItemCount ?? 1,
      );
      const windowStart = indexes[0] ?? -1;
      const windowEnd = indexes[indexes.length - 1] ?? -1;

      React.useLayoutEffect(() => {
        if (windowStart >= 0 && windowEnd >= 0) {
          rangeChangedRef.current?.({
            startIndex: windowStart,
            endIndex: windowEnd,
          });
        }
        const done = pendingDoneRef.current;
        pendingDoneRef.current = null;
        done?.();
      }, [centerIndex, windowStart, windowEnd]);

      return React.createElement(
        "div",
        {
          id: props.id,
          role: props.role,
          "aria-label": props["aria-label"],
          "data-testid": props["data-testid"],
          className: props.className,
          tabIndex: props.tabIndex,
        },
        ...indexes.map((index) => {
          const item = mockVirtuosoState.transientUndefinedIndexes.has(index)
            ? undefined
            : data[index];
          return React.createElement(
            React.Fragment,
            {
              key: props.computeItemKey?.(index, item) ?? index,
            },
            props.itemContent?.(index, item, props.context),
          );
        }),
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
    return Math.min(Math.max(rawIndex, 0), totalCount - 1);
  }

  function mockVirtuosoIndexes(
    totalCount: number,
    centerIndex: number,
    requestedWindowSize: number,
  ): ReadonlyArray<number> {
    const windowSize = Math.max(requestedWindowSize, 1);
    const clampedCenter = Math.min(
      Math.max(centerIndex, 0),
      Math.max(totalCount - 1, 0),
    );
    const start = Math.min(
      Math.max(0, clampedCenter - Math.floor(windowSize / 2)),
      Math.max(totalCount - windowSize, 0),
    );
    const end = Math.min(totalCount, start + windowSize);
    return Array.from(
      { length: end - start },
      (_unused, index) => start + index,
    );
  }

  return { Virtuoso };
});

import { NewWorktreeForm } from "../new-worktree-form";

const AUTOSAVE_DELAY_MS = 500;

const SUMMARY: WorktreeWorkspaceSummary = {
  workspacePath: "/repo",
  isGitRepo: true,
  repoIdentifier: { owner: "acme", repo: "app" },
  mainBranch: "development",
  worktrees: [
    {
      worktreePath: "/repo",
      branch: "development",
      head: null,
      isMain: true,
      isLocked: false,
    },
  ],
  scripts: null,
};

const STAGED_DEVELOPMENT_INTENT: WorktreeFolderIntent = {
  kind: "worktree",
  scripts: null,
  workspacePath: "/repo",
  repoIdentifier: { owner: "acme", repo: "app" },
  isPrimary: true,
  branch: {
    type: "new",
    name: "feat/saved",
    source: "development",
    carryUncommittedChanges: false,
  },
};

function renderForm(
  onEmit: (intent: WorktreeFolderIntent) => void,
  currentIntent: WorktreeFolderIntent | null,
): void {
  renderFormWithSummary(onEmit, currentIntent, SUMMARY);
}

function renderFormWithSummary(
  onEmit: (intent: WorktreeFolderIntent) => void,
  currentIntent: WorktreeFolderIntent | null,
  summary: WorktreeWorkspaceSummary,
): void {
  function ControlledForm() {
    const [stagedIntent, setStagedIntent] = useState(currentIntent);
    return (
      <NewWorktreeForm
        hostClient={null}
        workspacePath="/repo"
        repoIdentifier={{ owner: "acme", repo: "app" }}
        isPrimary
        summary={summary}
        currentIntent={stagedIntent}
        defaultNewBranchName="traycer/swift-otter"
        onEmit={(intent) => {
          onEmit(intent);
          setStagedIntent(intent);
        }}
      />
    );
  }

  render(
    <TooltipProvider>
      <ControlledForm />
    </TooltipProvider>,
  );
}

async function selectSource(name: string): Promise<void> {
  await Promise.resolve();
  // The source list is inline in the form (always rendered) — pick a row from it.
  const listbox = screen.getByRole("listbox", {
    name: "Worktree source branch",
  });
  fireEvent.click(within(listbox).getByText(name));
}

function expectActiveSourceOptionMounted(): void {
  const search = screen.getByRole("combobox", { name: "Search branches" });
  const activeId = search.getAttribute("aria-activedescendant");
  expect(activeId).not.toBeNull();
  if (activeId === null) return;
  const activeOption = document.getElementById(activeId);
  expect(activeOption).not.toBeNull();
  expect(
    screen
      .getByRole("listbox", { name: "Worktree source branch" })
      .contains(activeOption),
  ).toBe(true);
}

function flushAutosave(): void {
  act(() => {
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockVirtuosoState.captureConfiguration.mockClear();
  mockVirtuosoState.scrollIntoView.mockClear();
  mockVirtuosoState.transientUndefinedIndexes.clear();
  mockVirtuosoState.delayedScroll = false;
  mockVirtuosoState.pendingScrollApply = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  branchesData = undefined;
  branchesLoading = false;
  mockVirtuosoState.delayedScroll = false;
  mockVirtuosoState.pendingScrollApply = null;
});

describe("NewWorktreeForm — typing performance", () => {
  it("does not rebuild the source search index while the branch name changes", () => {
    branchesData = {
      branches: Array.from({ length: 150 }, (_, index) => ({
        name: `feature/branch-${index}`,
        isCurrent: false,
        isRemoteOnly: false,
      })),
      uncommittedFileCount: 0,
    };
    const createSearchIndex = vi.spyOn(
      worktreeBranchSearch,
      "createWorktreeBranchSearchIndex",
    );
    const renderSourceRow = vi.spyOn(
      worktreeBranchPickerOptions,
      "PickerOptionButton",
    );
    renderForm(() => undefined, null);
    expect(createSearchIndex).toHaveBeenCalledTimes(1);
    expect(mockVirtuosoState.captureConfiguration).toHaveBeenLastCalledWith({
      defaultItemHeight: 32,
      increaseViewportBy: 64,
      initialItemCount: 12,
    });
    // Virtual window is ≤12 options; aria-activedescendant publish may re-render
    // that window once after mount (rangeChanged / scrollIntoView done).
    const initialRowRenderCount = renderSourceRow.mock.calls.length;
    expect(initialRowRenderCount).toBeGreaterThan(0);
    expect(initialRowRenderCount).toBeLessThanOrEqual(24);
    expect(
      within(
        screen.getByRole("listbox", { name: "Worktree source branch" }),
      ).getAllByRole("option").length,
    ).toBeLessThanOrEqual(12);

    const name = screen.getByTestId("new-worktree-branch-name");
    for (const value of ["f", "fe", "fea", "feat", "feat/snappy"]) {
      fireEvent.change(name, { target: { value } });
    }

    expect(screen.getByDisplayValue("feat/snappy")).toBe(name);
    expect(createSearchIndex).toHaveBeenCalledTimes(1);
    // Branch-name typing must not re-render source rows.
    expect(renderSourceRow).toHaveBeenCalledTimes(initialRowRenderCount);
  });

  it("virtualizes source rows while keeping the active option mounted", () => {
    branchesData = {
      branches: Array.from({ length: 150 }, (_, index) => ({
        name: index === 149 ? "origin/release-149" : `feature/branch-${index}`,
        isCurrent: false,
        isRemoteOnly: index === 149,
      })),
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);

    const search = screen.getByRole("combobox", { name: "Search branches" });
    const listbox = screen.getByRole("listbox", {
      name: "Worktree source branch",
    });
    expect(search.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox).toHaveProperty("tabIndex", -1);
    expect(within(listbox).getAllByRole("option").length).toBeLessThanOrEqual(
      12,
    );

    fireEvent.keyDown(search, { key: "End" });

    expect(mockVirtuosoState.scrollIntoView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        index: 150,
        behavior: "auto",
      }),
    );
    expectActiveSourceOptionMounted();

    fireEvent.keyDown(search, { key: "Home" });
    expectActiveSourceOptionMounted();
    expect(mockVirtuosoState.scrollIntoView).toHaveBeenLastCalledWith(
      expect.objectContaining({
        index: 0,
        behavior: "auto",
      }),
    );

    fireEvent.keyDown(search, { key: "End" });
    expectActiveSourceOptionMounted();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByDisplayValue("release-149")).toBeTruthy();

    fireEvent.change(search, { target: { value: "feature/branch-0" } });
    expectActiveSourceOptionMounted();
    const filteredActiveId = search.getAttribute("aria-activedescendant");
    expect(filteredActiveId).not.toBeNull();
    const filteredActiveOption = document.getElementById(
      filteredActiveId ?? "",
    );
    expect(filteredActiveOption).not.toBeNull();
    expect(
      screen
        .getByRole("listbox", { name: "Worktree source branch" })
        .contains(filteredActiveOption),
    ).toBe(true);
  });

  it("keeps search focused while filtering without remounting the listbox", () => {
    branchesData = {
      branches: Array.from({ length: 40 }, (_, index) => ({
        name: `feature/branch-${index}`,
        isCurrent: index === 0,
        isRemoteOnly: false,
      })),
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);
    const search = screen.getByRole("combobox", { name: "Search branches" });
    const listbox = screen.getByRole("listbox", {
      name: "Worktree source branch",
    });
    search.focus();
    expect(document.activeElement).toBe(search);

    for (const value of ["f", "fe", "fea", "feat", "feature/branch-1"]) {
      fireEvent.change(search, { target: { value } });
    }

    expect(document.activeElement).toBe(search);
    expect(
      screen.getByRole("listbox", { name: "Worktree source branch" }),
    ).toBe(listbox);
    expectActiveSourceOptionMounted();
  });

  it("tolerates a transient undefined row from Virtuoso", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    mockVirtuosoState.transientUndefinedIndexes.add(0);

    expect(() => renderForm(() => undefined, null)).not.toThrow();
    expect(
      screen.getByRole("listbox", { name: "Worktree source branch" }),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /chore\/cleanup/ })).toBeTruthy();
  });

  it("names aria-activedescendant from the current active row", () => {
    branchesData = {
      branches: Array.from({ length: 150 }, (_, index) => ({
        name: index === 149 ? "origin/release-149" : `feature/branch-${index}`,
        isCurrent: false,
        isRemoteOnly: index === 149,
      })),
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);

    const search = screen.getByRole("combobox", { name: "Search branches" });
    fireEvent.keyDown(search, { key: "End" });
    // Pure-render ARIA: the combobox names the active row immediately from
    // activeIndex (may briefly be off-window under real virtualization).
    const activeId = search.getAttribute("aria-activedescendant");
    expect(activeId).not.toBeNull();
    expect(activeId).toMatch(/release-149|origin\/release-149/);
    expectActiveSourceOptionMounted();
  });
});

describe("NewWorktreeForm — new-branch name", () => {
  it("working tree source: name required (prefilled), then autosaved", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // Working tree is the default source → name prefilled with the generated
    // default and the placeholder reads "required".
    expect(screen.getByDisplayValue("traycer/swift-otter")).toBeTruthy();
    expect(
      screen
        .getByTestId("new-worktree-branch-name")
        .getAttribute("placeholder"),
    ).toBe("New branch name (required)");
    expect(screen.queryByTestId("new-worktree-select")).toBeNull();
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saving…",
    );
    flushAutosave();
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("working tree source: clearing the name pauses autosave and Enter is inert", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, null);
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "  " } });
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Branch name required",
    );
    fireEvent.keyDown(name, { key: "Enter" });
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("dirty tree: the 'Working tree' carry source forks WITH carryUncommittedChanges", async () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 3,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // A dirty tree exposes "Working tree · development" above the clean fork.
    await selectSource("Working tree · development");
    expect(screen.getByDisplayValue("traycer/swift-otter")).toBeTruthy();
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: true,
        },
      },
    ]);
  });

  it("dirty tree: the default clean fork still forks WITHOUT carry (start fresh)", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 3,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    // Default selection is the clean current-branch fork even when dirty.
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "development",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("remote source: prefilled name uses the source-specific generated default", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("origin/release-9");
    const name = screen.getByTestId("new-worktree-branch-name");
    expect((name as HTMLInputElement).value).toBe("release-9");
    expect(screen.queryByDisplayValue("traycer/swift-otter")).toBeNull();

    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "release-9",
          source: "origin/release-9",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("re-derives the source-specific name after the initial autosave echo", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);

    flushAutosave();
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );

    await selectSource("origin/release-9");
    expect(
      screen.getByTestId<HTMLInputElement>("new-worktree-branch-name").value,
    ).toBe("release-9");
    flushAutosave();

    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "release-9",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
  });

  it("does not move a newly selected source to the top until the next open", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("origin/release-9");
    expect(screen.getAllByRole("option")[0].textContent).toContain(
      "development",
    );

    flushAutosave();
    expect(emitted.at(-1)).toMatchObject({
      branch: { source: "origin/release-9" },
    });
    expectActiveSourceOptionMounted();
    expect(screen.getAllByRole("option")[0].textContent).toContain(
      "development",
    );

    cleanup();
    renderForm(() => undefined, emitted.at(-1) ?? null);
    expect(screen.getAllByRole("option")[0].textContent).toContain(
      "origin/release-9",
    );
  });

  it("moves the staged source to the top on open", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "release-9",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("origin/release-9");
  });

  it("local branch source: name required, prefilled, and forks from the source", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("chore/cleanup");
    const name = screen.getByTestId("new-worktree-branch-name");
    expect((name as HTMLInputElement).value).toBe("traycer/swift-otter");
    expect(name.getAttribute("placeholder")).toBe("New branch name (required)");
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saving…",
    );
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("local branch source: clearing the name pauses autosave", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn();
    renderForm(onEmit, null);
    await selectSource("chore/cleanup");
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "  " } });
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Branch name required",
    );
    fireEvent.keyDown(name, { key: "Enter" });
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("local branch source: a typed name forks from the selected branch", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    await selectSource("chore/cleanup");
    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/forked" },
    });
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "feat/forked",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("checked-out sibling branch appears as a selectable source", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "existing_branch_1", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderFormWithSummary((intent) => emitted.push(intent), null, {
      ...SUMMARY,
      worktrees: [
        ...SUMMARY.worktrees,
        {
          worktreePath: "/repo-existing-branch-1",
          branch: "existing_branch_1",
          sourceBranch: "development",
          head: null,
          isMain: false,
          isLocked: false,
        },
      ],
    });
    await selectSource("existing_branch_1");
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "existing_branch_1",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("arrow keys + Enter select the active source (keyboard nav)", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const emitted: WorktreeFolderIntent[] = [];
    renderForm((intent) => emitted.push(intent), null);
    const search = screen.getByRole("combobox", { name: "Search branches" });
    // Default active = the selected current-branch fork (development, index 0);
    // ArrowDown moves to chore/cleanup, Enter selects it WITHOUT leaving the box.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    flushAutosave();
    expect(emitted).toEqual([
      {
        kind: "worktree",
        scripts: null,
        workspacePath: "/repo",
        repoIdentifier: { owner: "acme", repo: "app" },
        isPrimary: true,
        branch: {
          type: "new",
          name: "traycer/swift-otter",
          source: "chore/cleanup",
          carryUncommittedChanges: false,
        },
      },
    ]);
  });

  it("mouse-clicking a source keeps focus in the form and waits for debounce", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "chore/cleanup", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    // Start from a staged (already-saved) intent so the default open timer is
    // not in flight; the click must not flush a premature default emit.
    renderForm(onEmit, STAGED_DEVELOPMENT_INTENT);
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    expect(onEmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );

    const form = screen.getByTestId("new-worktree-form");
    const listbox = screen.getByRole("listbox", {
      name: "Worktree source branch",
    });
    const option = within(listbox).getByRole("option", {
      name: /chore\/cleanup/,
    });
    // Browser focuses the option on mouse activation; if Virtuoso remounted on
    // selection the focused node would unmount and focus would fall to body,
    // which used to flush the draft before the 500ms debounce.
    option.focus();
    fireEvent.click(option);

    expect(document.activeElement).not.toBe(document.body);
    expect(form.contains(document.activeElement)).toBe(true);
    expect(
      screen.getByRole("listbox", { name: "Worktree source branch" }),
    ).toBe(listbox);
    expectActiveSourceOptionMounted();
    expect(onEmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saving…",
    );

    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    expect(onEmit).not.toHaveBeenCalled();
    flushAutosave();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        type: "new",
        name: "traycer/swift-otter",
        source: "chore/cleanup",
        carryUncommittedChanges: false,
      },
    });
  });

  it("keeps the source options out of the Tab order (tabIndex -1)", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, null);
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("shows a spinner inside the source list while branches are loading", () => {
    branchesLoading = true;
    branchesData = undefined;
    renderForm(() => undefined, null);
    // The popover content is present immediately with a loading affordance, and
    // no branch options render until the fetch resolves.
    expect(screen.getByText("Loading branches…")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("does not overwrite a staged source while its branch option hydrates", () => {
    branchesLoading = true;
    branchesData = undefined;
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const currentIntent: WorktreeFolderIntent = {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "release-9",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    };
    const subject = () => (
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={currentIntent}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>
    );
    const view = render(subject());
    const name = screen.getByTestId<HTMLInputElement>(
      "new-worktree-branch-name",
    );

    expect(name.value).toBe("release-9");
    expect(name.disabled).toBe(true);
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Waiting for source…",
    );
    fireEvent.blur(name, { relatedTarget: null });
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();

    branchesLoading = false;
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());

    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(name.value).toBe("release-9");
    expect(name.disabled).toBe(false);
    expect(
      screen
        .getByTestId("unified-picker-source-origin/release-9")
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
    expectActiveSourceOptionMounted();
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("waits for a removed explicit source instead of autosaving a fallback", async () => {
    branchesLoading = false;
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const currentIntent: WorktreeFolderIntent = {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    };
    const subject = () => (
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={currentIntent}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>
    );
    const view = render(subject());

    await selectSource("origin/release-9");
    const name = screen.getByTestId<HTMLInputElement>(
      "new-worktree-branch-name",
    );
    fireEvent.change(name, { target: { value: "feat/custom" } });

    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());

    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(name.value).toBe("feat/custom");
    expect(name.disabled).toBe(true);
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Waiting for source…",
    );
    expectActiveSourceOptionMounted();
    fireEvent.blur(name, { relatedTarget: null });
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();

    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());

    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(name.value).toBe("feat/custom");
    expect(name.disabled).toBe(false);
    expectActiveSourceOptionMounted();
    flushAutosave();
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        type: "new",
        name: "feat/custom",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
  });

  it("flushes the last valid explicit-source draft when closed during removal", async () => {
    branchesLoading = false;
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const currentIntent: WorktreeFolderIntent = {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    };
    const subject = () => (
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={currentIntent}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>
    );
    const view = render(subject());

    await selectSource("origin/release-9");
    const name = screen.getByTestId<HTMLInputElement>(
      "new-worktree-branch-name",
    );
    fireEvent.change(name, { target: { value: "feat/custom" } });
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());
    expect(name.disabled).toBe(true);
    expect(onEmit).not.toHaveBeenCalled();

    view.unmount();
    await act(() => Promise.resolve());

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        type: "new",
        name: "feat/custom",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
  });

  it("preserves an untouched derived name across source removal and restoration", async () => {
    branchesLoading = false;
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const currentIntent: WorktreeFolderIntent = {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    };
    const subject = () => (
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={currentIntent}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>
    );
    const view = render(subject());

    await selectSource("origin/release-9");
    const name = screen.getByTestId<HTMLInputElement>(
      "new-worktree-branch-name",
    );
    expect(name.value).toBe("release-9");

    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());
    expect(name.value).toBe("release-9");
    expect(name.disabled).toBe(true);
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();

    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    view.rerender(subject());
    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(name.value).toBe("release-9");
    expect(name.disabled).toBe(false);
    flushAutosave();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        type: "new",
        name: "release-9",
        source: "origin/release-9",
        carryUncommittedChanges: false,
      },
    });
  });

  it("shows the staged new-branch name on open, not a fresh default", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/keep-me",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    expect(screen.getByDisplayValue("feat/keep-me")).toBeTruthy();
    expect(screen.queryByDisplayValue("traycer/swift-otter")).toBeNull();
  });

  it("shows Saved when staged and Saving after an edit", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    renderForm(() => undefined, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    const status = screen.getByTestId("new-worktree-save-status");
    expect(status.textContent).toBe("Saved");
    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/changed" },
    });
    expect(status.textContent).toBe("Saving…");
  });
});

describe("NewWorktreeForm — autosave lifecycle", () => {
  it("preserves an untouched existing-branch checkout through debounce and close", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "feat/remembered", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: { type: "existing", name: "feat/remembered" },
    });

    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();

    cleanup();
    await act(() => Promise.resolve());
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("preserves an existing-branch checkout when its default source is re-selected", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "feat/remembered", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: { type: "existing", name: "feat/remembered" },
    });

    await selectSource("development");
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
    flushAutosave();
    expect(onEmit).not.toHaveBeenCalled();

    cleanup();
    await act(() => Promise.resolve());
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("autosaves a remembered existing-branch checkout after the user edits it", () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "feat/remembered", isCurrent: false, isRemoteOnly: false },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: { type: "existing", name: "feat/remembered" },
    });

    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/replacement" },
    });
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saving…",
    );
    flushAutosave();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        type: "new",
        name: "feat/replacement",
        source: "development",
      },
    });
  });

  it("ignores blur dispatched after the branch-name input becomes disabled", async () => {
    branchesData = {
      branches: [
        { name: "development", isCurrent: true, isRemoteOnly: false },
        { name: "origin/release-9", isCurrent: false, isRemoteOnly: true },
      ],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const view = render(
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={{
            kind: "worktree",
            scripts: null,
            workspacePath: "/repo",
            repoIdentifier: { owner: "acme", repo: "app" },
            isPrimary: true,
            branch: {
              type: "new",
              name: "feat/saved",
              source: "development",
              carryUncommittedChanges: false,
            },
          }}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>,
    );
    await selectSource("origin/release-9");
    const name = screen.getByTestId<HTMLInputElement>(
      "new-worktree-branch-name",
    );
    name.focus();
    fireEvent.change(name, { target: { value: "feat/custom" } });

    // Chromium dispatches blur synchronously as React commits `disabled`,
    // before the passive autosave effect can revoke interactive flushing.
    name.disabled = true;
    fireEvent.blur(name, { relatedTarget: null });
    expect(onEmit).not.toHaveBeenCalled();

    view.unmount();
    await act(() => Promise.resolve());
    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(onEmit.mock.calls[0][0]).toMatchObject({
      branch: {
        name: "feat/custom",
        source: "origin/release-9",
      },
    });
  });

  it("keeps the debounce intact through a StrictMode mount cycle", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    render(
      <StrictMode>
        <TooltipProvider>
          <NewWorktreeForm
            hostClient={null}
            workspacePath="/repo"
            repoIdentifier={{ owner: "acme", repo: "app" }}
            isPrimary
            summary={SUMMARY}
            currentIntent={null}
            defaultNewBranchName="traycer/swift-otter"
            onEmit={onEmit}
          />
        </TooltipProvider>
      </StrictMode>,
    );

    expect(onEmit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    expect(onEmit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onEmit).toHaveBeenCalledTimes(1);
  });

  it("keeps the same focused input when the saved intent echoes back", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    const name = screen.getByTestId("new-worktree-branch-name");
    name.focus();
    fireEvent.change(name, { target: { value: "feat/changed" } });
    flushAutosave();

    expect(onEmit).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect((name as HTMLInputElement).value).toBe("feat/changed");
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
  });

  it("cancels a pending save when typing returns to the staged value", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, {
      kind: "worktree",
      scripts: null,
      workspacePath: "/repo",
      repoIdentifier: { owner: "acme", repo: "app" },
      isPrimary: true,
      branch: {
        type: "new",
        name: "feat/saved",
        source: "development",
        carryUncommittedChanges: false,
      },
    });
    act(() => {
      vi.advanceTimersToNextFrame();
    });
    const name = screen.getByTestId("new-worktree-branch-name");
    name.focus();
    fireEvent.change(name, { target: { value: "feat/temporary" } });
    fireEvent.change(name, { target: { value: "feat/saved" } });
    flushAutosave();

    expect(onEmit).not.toHaveBeenCalled();
    expect(screen.getByTestId("new-worktree-branch-name")).toBe(name);
    expect(document.activeElement).toBe(name);
    expect(screen.getByTestId("new-worktree-save-status").textContent).toBe(
      "Saved",
    );
  });

  it("debounces rapid edits and emits only the latest valid draft", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, null);
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "feat/o" } });
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    fireEvent.change(name, { target: { value: "feat/only-this" } });
    act(() => {
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS - 1);
    });
    expect(onEmit).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onEmit).toHaveBeenCalledTimes(1);
    const emittedIntent = onEmit.mock.calls[0][0];
    if (emittedIntent.kind !== "worktree") {
      throw new Error("Expected a new-worktree intent");
    }
    expect(emittedIntent.branch).toEqual({
      type: "new",
      name: "feat/only-this",
      source: "development",
      carryUncommittedChanges: false,
    });
  });

  it("flushes the pending draft when focus leaves the form", () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    renderForm(onEmit, null);
    const name = screen.getByTestId("new-worktree-branch-name");
    fireEvent.change(name, { target: { value: "feat/save-on-blur" } });
    fireEvent.blur(name, { relatedTarget: null });
    expect(onEmit).toHaveBeenCalledTimes(1);
    const emittedIntent = onEmit.mock.calls[0][0];
    if (emittedIntent.kind !== "worktree") {
      throw new Error("Expected a new-worktree intent");
    }
    expect(emittedIntent.branch).toMatchObject({
      name: "feat/save-on-blur",
    });
  });

  it("flushes the pending draft when the popover unmounts", async () => {
    branchesData = {
      branches: [{ name: "development", isCurrent: true, isRemoteOnly: false }],
      uncommittedFileCount: 0,
    };
    const onEmit = vi.fn<(intent: WorktreeFolderIntent) => void>();
    const view = render(
      <TooltipProvider>
        <NewWorktreeForm
          hostClient={null}
          workspacePath="/repo"
          repoIdentifier={{ owner: "acme", repo: "app" }}
          isPrimary
          summary={SUMMARY}
          currentIntent={null}
          defaultNewBranchName="traycer/swift-otter"
          onEmit={onEmit}
        />
      </TooltipProvider>,
    );
    fireEvent.change(screen.getByTestId("new-worktree-branch-name"), {
      target: { value: "feat/save-on-close" },
    });
    view.unmount();
    await act(() => Promise.resolve());
    expect(onEmit).toHaveBeenCalledTimes(1);
    const emittedIntent = onEmit.mock.calls[0][0];
    if (emittedIntent.kind !== "worktree") {
      throw new Error("Expected a new-worktree intent");
    }
    expect(emittedIntent.branch).toMatchObject({
      name: "feat/save-on-close",
    });
  });
});
