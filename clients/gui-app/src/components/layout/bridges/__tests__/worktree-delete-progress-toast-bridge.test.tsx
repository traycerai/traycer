import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { WorktreeDeleteProgressSummary } from "@/components/settings/panels/use-worktree-delete-run";
import { WorktreeDeleteProgressToastBridge } from "@/components/layout/bridges/worktree-delete-progress-toast-bridge";
import { Toaster } from "@/components/ui/sonner";

const mocked = vi.hoisted<{
  summary: WorktreeDeleteProgressSummary;
}>(() => ({
  summary: {
    total: 0,
    deleted: 0,
    failed: 0,
    active: 0,
    scopeKeys: [],
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("@/components/settings/panels/use-worktree-delete-run", async () => {
  const actual = await vi.importActual<
    typeof import("@/components/settings/panels/use-worktree-delete-run")
  >("@/components/settings/panels/use-worktree-delete-run");
  return {
    ...actual,
    useWorktreeDeleteProgressSummary: () => mocked.summary,
  };
});

function progressSummary(input: {
  readonly scopeKeys: readonly string[];
  readonly total: number;
  readonly deleted: number;
  readonly failed: number;
  readonly active: number;
}): WorktreeDeleteProgressSummary {
  return input;
}

function renderBridge(): RenderResult {
  return render(
    <>
      <WorktreeDeleteProgressToastBridge />
      <Toaster />
    </>,
  );
}

async function dismissProgressToast(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Close toast" }));
  await waitFor(() => {
    expect(screen.queryByText("Deleting worktrees")).toBeNull();
    expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  });
}

function rerenderWithSummary(
  view: RenderResult,
  summary: WorktreeDeleteProgressSummary,
): void {
  mocked.summary = summary;
  act(() => {
    view.rerender(
      <>
        <WorktreeDeleteProgressToastBridge />
        <Toaster />
      </>,
    );
  });
}

describe("<WorktreeDeleteProgressToastBridge />", () => {
  beforeEach(() => {
    mocked.summary = progressSummary({
      scopeKeys: ["batch-a"],
      total: 6,
      deleted: 0,
      failed: 0,
      active: 6,
    });
  });

  afterEach(() => {
    toast.dismiss();
    vi.restoreAllMocks();
    cleanup();
  });

  it("keeps a dismissed batch quiet through later progress and success", async () => {
    const messageToastSpy = vi.spyOn(toast, "message");
    const view = renderBridge();

    await screen.findByText("0/6 deleted");
    await dismissProgressToast();
    messageToastSpy.mockClear();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a"],
        total: 6,
        deleted: 1,
        failed: 0,
        active: 5,
      }),
    );
    expect(messageToastSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Deleting worktrees")).toBeNull();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a"],
        total: 6,
        deleted: 6,
        failed: 0,
        active: 0,
      }),
    );
    expect(screen.queryByText("Deleted 6 worktrees")).toBeNull();
  });

  it("breaks through progress suppression when the batch fails", async () => {
    const view = renderBridge();

    await screen.findByText("0/6 deleted");
    await dismissProgressToast();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a"],
        total: 6,
        deleted: 5,
        failed: 1,
        active: 0,
      }),
    );

    await screen.findByText("Deleted 5 of 6 worktrees");
    screen.getByText("5/6 deleted, 1 failed");
  });

  it("shows progress again when a new batch joins the active scope", async () => {
    const view = renderBridge();

    await screen.findByText("0/6 deleted");
    await dismissProgressToast();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a", "batch-b"],
        total: 8,
        deleted: 1,
        failed: 0,
        active: 7,
      }),
    );

    await screen.findByText("Deleting worktrees");
    screen.getByText("1/8 deleted");
  });

  it("does not suppress an undismissed batch after hiding combined progress", async () => {
    const view = renderBridge();

    await screen.findByText("0/6 deleted");
    await dismissProgressToast();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a", "batch-b"],
        total: 8,
        deleted: 0,
        failed: 0,
        active: 8,
      }),
    );
    await screen.findByText("Deleting worktrees");

    // Batch B settles before A. The bridge programmatically hides the
    // combined progress toast because A remains dismissed.
    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-a"],
        total: 6,
        deleted: 0,
        failed: 0,
        active: 6,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Deleting worktrees")).toBeNull();
    });

    // Once A settles, the most recent terminal group is B. Its success must
    // remain visible because the user never dismissed B.
    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-b"],
        total: 2,
        deleted: 2,
        failed: 0,
        active: 0,
      }),
    );
    await screen.findByText("Deleted 2 worktrees");
  });

  it("does not revive progress when one of several dismissed batches settles", async () => {
    mocked.summary = progressSummary({
      scopeKeys: ["batch-a", "batch-b"],
      total: 8,
      deleted: 0,
      failed: 0,
      active: 8,
    });
    const view = renderBridge();

    await screen.findByText("0/8 deleted");
    await dismissProgressToast();

    rerenderWithSummary(
      view,
      progressSummary({
        scopeKeys: ["batch-b"],
        total: 2,
        deleted: 0,
        failed: 0,
        active: 2,
      }),
    );

    expect(screen.queryByText("Deleting worktrees")).toBeNull();
  });
});
