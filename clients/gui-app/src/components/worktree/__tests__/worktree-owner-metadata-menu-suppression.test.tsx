import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * The "R" refresh shortcut is claimed only while the card is OPEN
 * (`worktree-owner-metadata.tsx`'s `useEffect(() => (open && canRefresh ? ...))`),
 * and the card's own `open` is a `useState` this component owns and hands to
 * `HoverCard` as a fully controlled `open`/`onOpenChange` pair. `HoverCard`'s
 * "shut while any menu is open anywhere" gate closes a controlled card by
 * calling `onOpenChange(false, "disabled")` - so this is the one real,
 * app-level place that gate's wiring reaches an actual keyboard shortcut, not
 * just a `data-state` attribute.
 */
vi.mock("@/components/worktree/worktree-owner-settings-header", () => ({
  WorktreeOwnerSettingsHeader: () => <span data-testid="settings-header" />,
}));
// Matches `hover-card.test.tsx`'s precedent: with motion on, closing schedules
// a real transition before the content unmounts, which is `useTransitionStyles`'
// concern, not this suppression gate's.
vi.mock("@/lib/animation/use-motion-enabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/animation/use-motion-enabled")>();
  return { ...actual, useMotionEnabled: () => false };
});
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  // Truthy: `canRefresh = client !== null` must be `true` for the shortcut to
  // do anything, so a null client here would make the mutation vacuous.
  useHostClientForHostId: () => ({}),
}));

interface MetadataResult {
  readonly binding: null;
  readonly worktrees: readonly never[];
  readonly workspaces: readonly never[];
  readonly isPending: boolean;
  readonly error: null;
  readonly hostUnavailable: boolean;
  readonly checkedAt: number | null;
  readonly isRefreshing: boolean;
  readonly refresh: () => Promise<void>;
}

function baseMetadataResult(): MetadataResult {
  return {
    binding: null,
    worktrees: [],
    workspaces: [],
    isPending: false,
    error: null,
    hostUnavailable: false,
    checkedAt: null,
    isRefreshing: false,
    refresh: () => Promise.resolve(),
  };
}
vi.mock("@/hooks/worktree/use-worktree-owner-metadata-query", () => ({
  useWorktreeOwnerMetadata: () => baseMetadataResult(),
}));

const sendRefresh = vi.fn();
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => ({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => {
      sendRefresh();
    },
  }),
}));

const OPEN_DELAY_MS = 500;
const HOVER_TESTID = "chat-navigator-worktree-hover-owner-1";

function hoverIn(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
  fireEvent.mouseEnter(trigger);
}

function settle(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function pressR(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", cancelable: true }),
    );
  });
}

function renderScene(): {
  readonly row: HTMLElement;
  readonly menuTrigger: HTMLElement;
} {
  render(
    <div>
      <WorktreeOwnerMetadataTooltip
        trigger={
          <button type="button" data-testid="row">
            Chat row
          </button>
        }
        title="A chat"
        hostId="host-1"
        epicId="epic-1"
        ownerId="owner-1"
        ownerKind="chat"
        supplementalContent={null}
        side="right"
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button type="button" data-testid="menu-trigger">
            Menu row
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Item</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>,
  );
  return {
    row: screen.getByTestId("row"),
    menuTrigger: screen.getByTestId("menu-trigger"),
  };
}

describe("WorktreeOwnerMetadataTooltip: menu-gate suppression", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sendRefresh.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("unclaims 'R' the instant an unrelated menu opens, and the card stays closed once the menu closes", () => {
    const { row, menuTrigger } = renderScene();

    hoverIn(row);
    settle(OPEN_DELAY_MS);
    expect(screen.getByTestId(HOVER_TESTID)).toBeTruthy();

    pressR();
    expect(sendRefresh).toHaveBeenCalledTimes(1);

    fireEvent.contextMenu(menuTrigger);
    settle(0);
    expect(screen.queryByTestId(HOVER_TESTID)).toBeNull();

    sendRefresh.mockClear();
    pressR();
    expect(sendRefresh).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    settle(0);
    expect(screen.queryByRole("menu")).toBeNull();
    // No spontaneous reopen once the menu (and its suppression) is gone.
    expect(screen.queryByTestId(HOVER_TESTID)).toBeNull();
    sendRefresh.mockClear();
    pressR();
    expect(sendRefresh).not.toHaveBeenCalled();
  });

  it("names the card by its title through an accessible dialog role", () => {
    // This owner preview is content with an action (a Refresh button, the
    // `R` shortcut) - the "dialog" half of `semantics`, not "tooltip" - and
    // it names itself with the row's own title, not a generic label.
    const { row } = renderScene();

    hoverIn(row);
    settle(OPEN_DELAY_MS);

    expect(screen.getByRole("dialog", { name: "A chat" })).toBeTruthy();
  });
});
