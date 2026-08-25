import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import {
  ChatDiffTargetContext,
  type ChatSnapshotDiffOpener,
} from "@/components/chat/chat-diff-target";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("<ChatAccumulatedChangesPanel />", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens a cumulative bundle tile from Review all", () => {
    const reviewAll = vi.fn();
    const cumulativeBundle = vi.fn(() => reviewAll);

    renderPanel({
      changes: [
        fileChange("/repo/src/app.ts"),
        fileChange("/repo/src/other.ts"),
      ],
      activeTurnStatus: null,
      opener: {
        segment: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulative: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Review all changes" }));

    expect(cumulativeBundle).toHaveBeenCalledWith([
      "/repo/src/app.ts",
      "/repo/src/other.ts",
    ]);
    expect(reviewAll).toHaveBeenCalledTimes(1);
  });

  it("hides Review all when no diff target is available", () => {
    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: null,
      opener: null,
    });

    expect(
      screen.queryByRole("button", { name: "Review all changes" }),
    ).toBeNull();
  });

  it("hides Review all while a turn is in progress", () => {
    const cumulativeBundle = vi.fn(() => vi.fn());

    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: "running",
      opener: {
        segment: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulative: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle,
      },
    });

    expect(
      screen.queryByRole("button", { name: "Review all changes" }),
    ).toBeNull();
    expect(cumulativeBundle).not.toHaveBeenCalled();
  });

  it("shows an active-turn row's live magnitude in the header total", () => {
    // A file the running turn created has no host version yet, so its row is
    // the client's own and its counts are the per-edit magnitudes summed across
    // the turn. The header must show those rather than nothing.
    renderPanel({
      changes: [
        streamingChange("/repo/src/app.ts", { additions: 5, deletions: 2 }),
      ],
      activeTurnStatus: "running",
      opener: null,
    });

    expect(screen.getByText("+5")).not.toBeNull();
    expect(screen.getByText("−2")).not.toBeNull();
  });

  it("omits an uncountable row from the header total rather than adding zero", () => {
    // `counts: null` is "no diff to count" (`diffSource: "none"`), which is a
    // different statement from `{0, 0}`. It must not drag the total to nothing
    // when a countable row is sitting beside it.
    renderPanel({
      changes: [
        fileChange("/repo/src/app.ts"),
        {
          ...fileChange("/repo/NOTES"),
          diffSource: "none",
          counts: null,
          hasContents: false,
        },
      ],
      activeTurnStatus: null,
      opener: null,
    });

    expect(screen.getByText("2 files changed")).not.toBeNull();
    expect(screen.getByText("+1")).not.toBeNull();
    expect(screen.getByText("−1")).not.toBeNull();
  });
});

/**
 * On the windowed line the summaries arrive as chunks while the snapshot states
 * the total up front, so the list is a PREFIX until they all land. "Undo all"
 * reverts the host's whole set regardless, so neither the header nor the
 * artifact opt-out may be counted off the rows on screen.
 */
describe("<ChatAccumulatedChangesPanel /> partial summary set", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("counts the host's whole set in the header, not the rows delivered", () => {
    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: null,
      opener: null,
      undeliveredChangeCount: 6,
    });

    expect(screen.getByText("7 files changed")).not.toBeNull();
  });

  it("renders while the count is known and no summary has arrived", () => {
    // The panel hides itself on an empty set. It must not do that when the
    // snapshot has already said there are files - it would flash out and back.
    renderPanel({
      changes: [],
      activeTurnStatus: null,
      opener: null,
      undeliveredChangeCount: 4,
    });

    expect(screen.getByTestId("accumulated-changes-panel")).not.toBeNull();
    expect(screen.getByText("4 files changed")).not.toBeNull();
  });

  it("drops the artifact count from Undo all while the set is a prefix", () => {
    renderPanel({
      changes: [
        {
          ...fileChange("/repo/artifacts/a/index.md"),
          artifact: { artifactId: "a1", kind: "spec", title: "Spec" },
        },
      ],
      activeTurnStatus: null,
      opener: null,
      undeliveredChangeCount: 3,
    });

    fireEvent.click(screen.getByTestId("accumulated-undo-all"));
    const dialog = screen.getByTestId("undo-all-dialog");
    // The opt-out still appears - it defaults to CHECKED, so hiding it would
    // revert artifacts with nothing having offered the choice - but without a
    // number, which would be counted off one row out of four.
    expect(screen.getByTestId("revert-artifacts-checkbox")).not.toBeNull();
    expect(dialog.textContent).not.toMatch(/also revert \d+ artifact/i);
  });
});

function renderPanel(input: {
  readonly changes: ReadonlyArray<AccumulatedChangeRow>;
  readonly activeTurnStatus: ChatRestoreContextValue["activeTurnStatus"];
  readonly opener: ChatSnapshotDiffOpener | null;
  readonly undeliveredChangeCount?: number;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDiffTargetContext.Provider value={input.opener}>
        <ChatAccumulatedChangesPanel
          restore={{
            ...baseRestore(input.changes, input.activeTurnStatus),
            undeliveredChangeCount: input.undeliveredChangeCount ?? 0,
          }}
          separated={false}
          scrollRegionMaxHeightClass="max-h-96"
        />
      </ChatDiffTargetContext.Provider>
    </TooltipProvider>,
  );
}

function baseRestore(
  changes: ReadonlyArray<AccumulatedChangeRow>,
  activeTurnStatus: ChatRestoreContextValue["activeTurnStatus"],
): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus,
    localSnapshotsClearedAt: null,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint: vi.fn().mockReturnValue(null),
    accumulatedFileChanges: changes,
    undeliveredChangeCount: 0,
    revertFileChanges: vi.fn().mockReturnValue(null),
  };
}

function fileChange(filePath: string): AccumulatedChangeRow {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts: { additions: 1, deletions: 1 },
    hasContents: true,
    // A host row on the pre-windowed line: its contents rode the snapshot, so
    // there is no version to quote and nothing to fetch.
    digest: null,
  };
}

function streamingChange(
  filePath: string,
  counts: AccumulatedChangeRow["counts"],
): AccumulatedChangeRow {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: null,
    counts,
    hasContents: true,
    digest: null,
  };
}
