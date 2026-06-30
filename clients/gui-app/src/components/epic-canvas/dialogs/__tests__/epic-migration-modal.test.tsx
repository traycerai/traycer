import "../../../../../__tests__/test-browser-apis";
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
});
