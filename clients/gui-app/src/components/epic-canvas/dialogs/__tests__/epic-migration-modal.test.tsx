import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EpicMigrationModal } from "@/components/epic-canvas/dialogs/epic-migration-modal";
import type { EpicMigrationSlice } from "@/stores/epics/open-epic/store";

interface EpicSelectorsMockState {
  migration: EpicMigrationSlice;
  retryMigration: () => void;
}

const epicSelectorsMockState = vi.hoisted((): EpicSelectorsMockState => ({
  migration: {
    status: "idle",
    phase: null,
    chunksDone: 0,
    chunksTotal: 0,
  },
  retryMigration: vi.fn(),
}));

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicMigrationState: () => epicSelectorsMockState.migration,
  useEpicRetryMigration: () => epicSelectorsMockState.retryMigration,
}));

describe("<EpicMigrationModal />", () => {
  afterEach(() => {
    cleanup();
    epicSelectorsMockState.migration = {
      status: "idle",
      phase: null,
      chunksDone: 0,
      chunksTotal: 0,
    };
    epicSelectorsMockState.retryMigration = vi.fn();
    navigateMock.mockReset();
  });

  it("renders the epic-open migration blocker in-place under the epic pane", () => {
    epicSelectorsMockState.migration = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };

    const { container } = render(
      <>
        <button type="button" data-testid="tab-strip-button">
          Tab A
        </button>
        <div data-testid="epic-pane" className="relative">
          <div data-testid="epic-shell" data-epic-shell-root="true">
            <button type="button">Blocked shell action</button>
          </div>
          <EpicMigrationModal tabId="tab-a" />
        </div>
      </>,
    );

    const layer = screen.getByTestId("epic-migration-layer");
    const overlay = screen.getByTestId("epic-migration-overlay");
    const modal = screen.getByRole("dialog", {
      name: "Migrating your epic",
    });
    const shell = screen.getByTestId("epic-shell");
    const tabButton = screen.getByRole("button", { name: "Tab A" });

    expect(container.contains(layer)).toBe(true);
    expect(container.contains(overlay)).toBe(true);
    expect(container.contains(modal)).toBe(true);
    expect(layer.className).toContain("absolute");
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).not.toContain("fixed");
    expect(modal.className).toContain("absolute");
    expect(modal.className).not.toContain("fixed");
    expect(shell.getAttribute("inert")).toBe("");
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    expect(tabButton.getAttribute("inert")).toBeNull();
  });

  it("renders the viewer 'not allowed' state with a Close-tab button and no Retry", () => {
    epicSelectorsMockState.migration = {
      status: "not-allowed",
      phase: null,
      chunksDone: 0,
      chunksTotal: 0,
    };

    render(
      <div data-testid="epic-pane" className="relative">
        <div data-testid="epic-shell" data-epic-shell-root="true" />
        <EpicMigrationModal tabId="tab-a" />
      </div>,
    );

    expect(
      screen.getByRole("dialog", { name: "This epic needs an update" }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("epic-migration-not-allowed-close-button"),
    ).toBeTruthy();
    // No retry affordance: this caller can never perform the migration.
    expect(screen.queryByTestId("epic-migration-retry-button")).toBeNull();
    // Shell stays blocked - the un-migrated epic must not be interacted with.
    expect(screen.getByTestId("epic-shell").getAttribute("inert")).toBe("");
  });

  // Acceptance test for the coordinator-approved fix (production not yet
  // updated - `<DialogPopup>` still has no `<Dialog.Portal>` ancestor at all,
  // so this fails the same way as the test above until that lands): each
  // pane's modal must portal into ITS OWN pane-local container (the existing
  // `modalRootRef` div, i.e. `epic-migration-layer`) - never to
  // `document.body`, never into the other pane, and never inside the shell
  // that same pane just made inert (a container nested in its own inert
  // shell would make the modal it carries just as unusable as the shell).
  it("mounts each pane's modal in its own pane when two panes migrate concurrently", () => {
    epicSelectorsMockState.migration = {
      status: "running",
      phase: "upload",
      chunksDone: 1,
      chunksTotal: 2,
    };

    render(
      <>
        <div data-testid="epic-pane-a" className="relative">
          <div data-testid="epic-shell-a" data-epic-shell-root="true">
            <button type="button">Pane A action</button>
          </div>
          <EpicMigrationModal tabId="tab-a" />
        </div>
        <div data-testid="epic-pane-b" className="relative">
          <div data-testid="epic-shell-b" data-epic-shell-root="true">
            <button type="button">Pane B action</button>
          </div>
          <EpicMigrationModal tabId="tab-b" />
        </div>
        {/* Neither pane above is migrating-alone here - both are. A button
            INSIDE a migrating pane's own inert shell is correctly excluded
            from the accessibility tree (Testing Library won't find it via
            getByRole), so it can't prove cross-pane safety. This third,
            non-migrating pane's action is the one that can: it must stay
            fully reachable while both other panes are blocked. */}
        <div data-testid="epic-pane-c" className="relative">
          <div data-testid="epic-shell-c" data-epic-shell-root="true">
            <button type="button">Pane C action</button>
          </div>
        </div>
      </>,
    );

    const paneA = screen.getByTestId("epic-pane-a");
    const paneB = screen.getByTestId("epic-pane-b");
    const shellA = screen.getByTestId("epic-shell-a");
    const shellB = screen.getByTestId("epic-shell-b");
    const shellC = screen.getByTestId("epic-shell-c");
    const [modalA, modalB] = screen.getAllByRole("dialog", {
      name: "Migrating your epic",
    });

    // Each modal stays inside its own pane, never the other pane, and never
    // escapes to `document.body` (the default Portal target).
    expect(paneA.contains(modalA)).toBe(true);
    expect(paneB.contains(modalA)).toBe(false);
    expect(paneB.contains(modalB)).toBe(true);
    expect(paneA.contains(modalB)).toBe(false);
    expect(document.body.contains(modalA)).toBe(true);

    // The container a modal lands in is a sibling of that pane's shell, not a
    // descendant of it - so the modal carries no inherited `inert` ancestor.
    expect(shellA.contains(modalA)).toBe(false);
    expect(shellB.contains(modalB)).toBe(false);
    expect(modalA.closest("[inert]")).toBeNull();
    expect(modalB.closest("[inert]")).toBeNull();

    // Both panes' own shells are blocked, independently - each one only ever
    // nests inside ITS OWN shell (a structural check, since a button inside
    // an inert shell is correctly excluded from the accessibility tree and
    // getByRole can't reach it to ask).
    expect(shellA.getAttribute("inert")).toBe("");
    expect(shellB.getAttribute("inert")).toBe("");
    expect(shellA.querySelector("button")?.closest("[inert]")).toBe(shellA);
    expect(shellB.querySelector("button")?.closest("[inert]")).toBe(shellB);

    // Cross-pane safety, proven for real: a third, non-migrating pane's
    // action stays fully reachable and uninert while the other two are
    // blocked - containment never leaks app-wide.
    expect(shellC.getAttribute("inert")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Pane C action" })
        .getAttribute("inert"),
    ).toBeNull();
  });
});
