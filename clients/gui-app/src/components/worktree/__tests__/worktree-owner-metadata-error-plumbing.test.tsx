import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { WorktreeOwnerMetadataTooltip } from "@/components/worktree/worktree-owner-metadata";

/**
 * Unlike `worktree-owner-metadata-hover-gate.test.tsx`, this file leaves the
 * real `OwnerWorkspaceMetadataContent` in place - it is specifically about
 * whether the tooltip combines `useWorktreeOwnerMetadata`'s and
 * `useOwnerListPrReferences`'s error signals into the ONE `error` prop that
 * component renders from, not about hover/gate mechanics.
 */
vi.mock("@/components/worktree/worktree-owner-settings-header", () => ({
  WorktreeOwnerSettingsHeader: () => <span data-testid="settings-header" />,
}));
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

interface MetadataResult {
  readonly binding: null;
  readonly worktrees: readonly never[];
  readonly workspaces: readonly never[];
  readonly isPending: boolean;
  readonly error: HostRpcError | null;
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

const metadataResult = vi.hoisted<{ current: MetadataResult }>(() => ({
  current: {
    binding: null,
    worktrees: [],
    workspaces: [],
    isPending: false,
    error: null,
    hostUnavailable: false,
    checkedAt: null,
    isRefreshing: false,
    refresh: () => Promise.resolve(),
  },
}));
vi.mock("@/hooks/worktree/use-worktree-owner-metadata-query", () => ({
  useWorktreeOwnerMetadata: () => metadataResult.current,
}));

interface OwnerPrResult {
  readonly references: readonly never[];
  readonly isPending: boolean;
  readonly error: boolean;
  readonly sendRefresh: () => void;
}

function baseOwnerPrResult(): OwnerPrResult {
  return {
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  };
}

const ownerPrResult = vi.hoisted<{ current: OwnerPrResult }>(() => ({
  current: {
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  },
}));
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => ownerPrResult.current,
}));

const OPEN_DELAY_MS = 500;

function hoverIn(trigger: HTMLElement): void {
  fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
}

function settleOpenDelay(): void {
  act(() => {
    vi.advanceTimersByTime(OPEN_DELAY_MS * 2);
  });
}

function openTooltip(): void {
  render(
    <WorktreeOwnerMetadataTooltip
      trigger={
        <button type="button" data-testid="row">
          Chat row
        </button>
      }
      title="A chat with no linked workspace"
      hostId="host-1"
      epicId="epic-1"
      ownerId="owner-1"
      ownerKind="chat"
      supplementalContent={null}
      side="right"
    />,
  );
  hoverIn(screen.getByTestId("row"));
  settleOpenDelay();
}

describe("WorktreeOwnerMetadataTooltip error plumbing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    metadataResult.current = baseMetadataResult();
    ownerPrResult.current = baseOwnerPrResult();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the inline error when only the PR subscription errors, even though the workspace metadata read found nothing", () => {
    // Regression: the tooltip used to pass ONLY `metadata.error` into
    // `OwnerWorkspaceMetadataContent`'s `error` prop, so an owner with no
    // workspace and a FAILED PR subscription silently rendered "No workspace
    // linked" - a definitive claim about the owner - instead of surfacing
    // that a read had actually failed.
    ownerPrResult.current = { ...baseOwnerPrResult(), error: true };

    openTooltip();

    expect(screen.getByText("Unable to load workspace details")).toBeTruthy();
    expect(screen.queryByText("No workspace linked")).toBeNull();
  });

  it("still shows the inline error from the workspace metadata read alone (non-regression)", () => {
    metadataResult.current = {
      ...baseMetadataResult(),
      error: new HostRpcError({
        code: "RPC_ERROR",
        message: "Could not reach the worktree service.",
        requestId: "req-error",
        method: "worktree.listAllForHost",
        fatalDetails: null,
      }),
    };

    openTooltip();

    expect(screen.getByText("Unable to load workspace details")).toBeTruthy();
  });

  it("does not show an error when neither read failed (non-regression)", () => {
    openTooltip();

    expect(screen.getByText("No workspace linked")).toBeTruthy();
    expect(screen.queryByText("Unable to load workspace details")).toBeNull();
  });
});
