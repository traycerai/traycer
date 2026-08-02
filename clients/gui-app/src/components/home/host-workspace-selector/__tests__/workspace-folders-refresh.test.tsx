import "../../../../../__tests__/test-browser-apis";
import {
  afterEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorktreeWorkspaceSummary } from "@traycer/protocol/host/worktree-schemas";
import { PaneSurfaceActivityContext } from "@/components/epic-tabs/pane-visibility-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeWorkspacesRefresh } from "@/hooks/worktree/use-worktree-workspaces-refresh";
import { claimBareKey } from "@/lib/keybindings/bare-key-owner";
import { WorkspaceFolderSummaryControl } from "../workspace-folder-summary-control";
import type { WorkspaceRunItem } from "../workspace-run-item";

// The rows' host-wide uncommitted query and the branch form's `listBranches`
// read. Neither is under test here - the refresh contract is exercised
// through the injected `refresh` object.
vi.mock("@/hooks/host/use-host-query", () => ({
  useHostQuery: () => ({ data: undefined, isLoading: false }),
}));

const NOOP = (): void => undefined;
const NOOP_ADD = (): Promise<boolean> => Promise.resolve(false);

const GIT_SUMMARY: WorktreeWorkspaceSummary = {
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

const ITEM: WorkspaceRunItem = {
  key: "/repo",
  displayName: "repo",
  displayPath: "/repo",
  unresolved: false,
  metadataPending: false,
  missing: false,
  isGitRepo: true,
  mode: "worktree",
  branchLabel: "traycer/swift-otter",
  summary: GIT_SUMMARY,
  currentIntent: null,
  defaultNewBranchName: "traycer/swift-otter",
  repoIdentifier: { owner: "acme", repo: "app" },
  isPrimary: true,
  canChangePrimary: true,
  makePrimaryDisabled: false,
  makePrimaryDisabledReason: null,
  hostClient: null,
  modeDisabled: false,
  modeDisabledReason: null,
  removeDisabled: false,
  removeDisabledReason: null,
  removePending: false,
  onSelectMode: NOOP,
  onEmit: NOOP,
  onLocate: null,
  onMakePrimary: NOOP,
  onRemove: null,
};

afterEach(cleanup);

describe("folder-mapping refresh affordance", () => {
  it("forces one re-derive when the picker opens, so the chip's stale branch heals on the way in", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });

    expect(fixture.refresh).not.toHaveBeenCalled();
    await fixture.openPicker();

    // The label the user is looking at lives on the COLLAPSED chip, outside
    // the only surface that can correct it. Waiting for a button press inside
    // the popover would mean the user must already know the value is wrong.
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
  });

  it("re-derives on R while the picker is open", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();

    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(document.body, { key: "r" });
      }),
    ).toBe(1);
  });

  it("leaves R alone while the caret is in the new-worktree branch name", async () => {
    // The reason this guard exists and the owner hover card's `R` has none:
    // that card is pointer-anchored over a row and holds no input, while this
    // popover's branch form is a text field the user types branch names into.
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();

    fireEvent.click(
      screen.getByRole("button", { name: "Choose worktree branch" }),
    );
    await screen.findByTestId("folder-branch-popover");
    const branchName = screen.getByRole("textbox", {
      name: "New branch name",
    });

    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(branchName, { key: "r" });
      }),
    ).toBe(0);
  });

  it("ignores R once the picker is closed", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();
    fireEvent.click(screen.getByTestId("workspace-summary-trigger"));
    await waitFor(() => {
      expect(screen.queryByTestId("home-workspace-rows-popover")).toBeNull();
    });

    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(document.body, { key: "r" });
      }),
    ).toBe(0);
  });

  it("ignores R with a modifier, which belongs to the app's own chords", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();

    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(document.body, { key: "r", metaKey: true });
        fireEvent.keyDown(document.body, { key: "r", ctrlKey: true });
      }),
    ).toBe(0);
  });

  it("reports the HOST's derive time, not the moment the response arrived", async () => {
    // Mid-bucket, not on a boundary: the label reads off a shared clock
    // sampled on a 60s tick, so an exactly-3-minute age lands either side of
    // the floor depending on where in the tick the test runs.
    const fixture = renderControl({
      checkedAt: Date.now() - 3.5 * 60_000,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();

    const checked = await screen.findByTestId("workspace-folders-checked-at");
    // 3m, not "now": the host serves these listings from a TTL cache, so a
    // client-side `dataUpdatedAt` would claim freshness the row does not have.
    expect(checked.textContent).toContain("3m");
  });

  it("keeps the folder list scrollable above an inset, fixed refresh footer", async () => {
    const fixture = renderControl({
      checkedAt: Date.now(),
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();

    const popover = screen.getByTestId("home-workspace-rows-popover");
    const scrollRegion = screen.getByTestId("workspace-folder-scroll-region");
    const footer = screen.getByTestId("workspace-refresh-footer");

    // The sidebar owner card keeps its refresh row outside the metadata scroll
    // region. The folder picker follows the same structure so the footer does
    // not need negative margins or sticky offsets inside a padded scroller.
    expect(popover.className).toContain("overflow-hidden");
    expect(popover.className).toContain("p-0");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain("px-3");
    expect(scrollRegion.className).toContain("pb-2");
    expect(footer.className).toContain("shrink-0");
    expect(footer.className).toContain("px-3");
    expect(footer.className).not.toContain("sticky");
    expect(footer.className).not.toContain("-mx-3");
  });

  it("offers no refresh affordance on a surface with nothing to refresh", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: false,
      canRefresh: false,
    });
    await fixture.openPicker();

    expect(
      screen.queryByRole("button", { name: "Refresh folder details" }),
    ).toBeNull();
  });

  it("stays quiet on open when the surface has no host to ask", async () => {
    // The production shape for an unreachable bound host: a refresh object is
    // present (so the footer renders) but `canRefresh` is false. The hook only
    // no-ops an EMPTY path list, so an ungated open would reject into
    // "Couldn't refresh folder details" - an error toast the user never asked
    // for, beside a Refresh button correctly rendered disabled.
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: false,
    });
    await fixture.openPicker();

    expect(refreshButton().disabled).toBe(true);
    expect(fixture.refresh).not.toHaveBeenCalled();
  });

  it("hands R back when a split partner takes focus and the picker leaves the screen", async () => {
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();

    // A pane-aware `PopoverContent` unmounts its portal when the sibling pane
    // takes focus, while deliberately leaving this controlled root OPEN so it
    // re-presents on refocus. An open-only gate would therefore keep a live
    // window-level listener for a picker that is no longer on screen.
    fixture.setPaneFocused(false);
    await waitFor(() => {
      expect(screen.queryByTestId("home-workspace-rows-popover")).toBeNull();
    });

    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(document.body, { key: "r" });
      }),
    ).toBe(0);

    // Positive control: refocusing re-presents the same open picker and R is
    // its own again, so the assertion above is about ownership and not about
    // the popover having been torn down for good.
    fixture.setPaneFocused(true);
    await screen.findByTestId("home-workspace-rows-popover");
    await fixture.settle();
    expect(
      fixture.refreshesDuring(() => {
        fireEvent.keyDown(document.body, { key: "r" });
      }),
    ).toBe(1);
  });

  it("does not steal R back from a newer overlay just because its own refresh finished", async () => {
    // `claimBareKey` is last-claim-wins, so re-claiming is a priority change,
    // not a no-op. The picker's key handler closes over `useRefreshSpinner`'s
    // `trigger`, whose identity moves every time `refreshing` toggles - so an
    // effect that depends on it re-claims when a refresh merely COMPLETES, and
    // this picker would silently take the key back from an owner hover card
    // the user opened over it in the meantime.
    const fixture = renderControl({
      checkedAt: null,
      wired: true,
      canRefresh: true,
    });
    await fixture.openPicker();
    await fixture.settle();

    // A newer overlay opens on top and takes the key.
    const newer = vi.fn();
    const releaseNewer = claimBareKey("r", newer);
    // Registered BEFORE the assertions below, not after: `claimBareKey` owns a
    // module-level stack and a window listener, so a failing assertion would
    // otherwise leave this claim on top for every later test in the file.
    onTestFinished(releaseNewer);

    // The picker's own refresh runs to completion - through the button, since
    // `R` is no longer its to press. `refreshing` goes true and back to false,
    // which is the identity change under test.
    fireEvent.click(refreshButton());
    await fixture.settle();

    const stolen = fixture.refreshesDuring(() => {
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(stolen).toBe(0);
    expect(newer).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Refresh affordance, by role and accessible name.
 *
 * Narrowed with `instanceof` rather than asserted: it makes the native
 * `disabled` property readable, and it is itself worth asserting - a refresh
 * "button" that is not a `<button>` would take neither Enter nor Space.
 */
function refreshButton(): HTMLButtonElement {
  const element = screen.getByRole("button", {
    name: "Refresh folder details",
  });
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("the Refresh affordance is not a <button>");
  }
  return element;
}

interface RefreshFixture {
  readonly refresh: Mock<() => Promise<void>>;
  readonly openPicker: () => Promise<void>;
  readonly settle: () => Promise<void>;
  readonly refreshesDuring: (act: () => void) => number;
  /** Flips the surrounding split pane's focus, as a sibling pane taking it would. */
  readonly setPaneFocused: (focused: boolean) => void;
}

function renderControl(over: {
  readonly checkedAt: number | null;
  /** `false` renders the surface with no refresh affordance at all. */
  readonly wired: boolean;
  /** Production passes a refresh object even when its host client is null. */
  readonly canRefresh: boolean;
}): RefreshFixture {
  const refresh = vi.fn(() => Promise.resolve());
  const state: WorktreeWorkspacesRefresh | null = over.wired
    ? {
        refresh,
        isRefreshing: false,
        checkedAt: over.checkedAt,
        canRefresh: over.canRefresh,
      }
    : null;
  const tree = (paneFocused: boolean): ReactNode => (
    <PaneSurfaceActivityContext.Provider
      value={{ visible: true, focused: paneFocused }}
    >
      <TooltipProvider>
        <WorkspaceFolderSummaryControl
          items={[ITEM]}
          readOnly={false}
          bindingResolved
          addFolderPending={false}
          addFolderDisabled={false}
          addFolderDisabledReason={null}
          onAddFolder={NOOP_ADD}
          onUpdate={null}
          updateEnabled={false}
          updatePending={false}
          onDiscardStaged={null}
          onEditEnvironment={NOOP}
          refresh={state}
          popoverTestId="home-workspace-rows-popover"
          popoverSide="top"
        />
      </TooltipProvider>
    </PaneSurfaceActivityContext.Provider>
  );
  const { rerender } = render(tree(true));
  return {
    refresh,
    setPaneFocused: (focused) => {
      rerender(tree(focused));
    },
    openPicker: async () => {
      fireEvent.click(screen.getByTestId("workspace-summary-trigger"));
      await screen.findByTestId("home-workspace-rows-popover");
    },
    // `useRefreshSpinner` holds the spinner up for a visible minimum after the
    // refresh resolves, and swallows a trigger while it is up. Every "a second
    // refresh fires / does not fire" assertion below is only meaningful once
    // that window has closed - otherwise the spinner, not the guard under
    // test, would be what suppressed the call.
    settle: async () => {
      await waitFor(() => {
        if (refreshButton().disabled) {
          throw new Error("refresh still in flight");
        }
      });
    },
    // A DELTA, not an absolute count: every `R` assertion below is about what
    // one keystroke does, and pinning the total would make each of them fail
    // for the unrelated reason that the open-intent refresh had changed.
    refreshesDuring: (act) => {
      const before = refresh.mock.calls.length;
      act();
      return refresh.mock.calls.length - before;
    },
  };
}
