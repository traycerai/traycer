import "../../../../__tests__/test-browser-apis";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccumulatedFileChange } from "@/lib/chat/accumulated-file-changes-from-messages";
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

  it("prefers streamingCounts over content-derived counts in the header total", () => {
    // An active-turn row has null before/after content but carries
    // `streamingCounts`. The header must show that live magnitude (+5 / −2)
    // rather than the zero a null-content diff would produce.
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
});

function renderPanel(input: {
  readonly changes: ReadonlyArray<AccumulatedFileChange>;
  readonly activeTurnStatus: ChatRestoreContextValue["activeTurnStatus"];
  readonly opener: ChatSnapshotDiffOpener | null;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDiffTargetContext.Provider value={input.opener}>
        <ChatAccumulatedChangesPanel
          restore={baseRestore(input.changes, input.activeTurnStatus)}
          separated={false}
          scrollRegionMaxHeightClass="max-h-96"
        />
      </ChatDiffTargetContext.Provider>
    </TooltipProvider>,
  );
}

function baseRestore(
  changes: ReadonlyArray<AccumulatedFileChange>,
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
    revertFileChanges: vi.fn().mockReturnValue(null),
  };
}

function fileChange(filePath: string): AccumulatedFileChange {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent: "old\n",
    afterContent: "new\n",
    reason: "snapshot",
    undoable: true,
    // Content-resolved host rows derive `+/-` from content, never streaming.
    streamingCounts: null,
  };
}

function streamingChange(
  filePath: string,
  streamingCounts: AccumulatedFileChange["streamingCounts"],
): AccumulatedFileChange {
  return {
    filePath,
    operation: "edit",
    diffSource: "snapshot",
    beforeContent: null,
    afterContent: null,
    reason: "snapshot",
    undoable: true,
    streamingCounts,
  };
}
