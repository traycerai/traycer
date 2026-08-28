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

  it("opens an active-turn row through the SEGMENT tile, not the cumulative one", () => {
    // The active turn's own row is the client's view of a file no host version
    // names yet: `digest: null`, and absent from both host arrays. Cumulative
    // resolution addresses a file by digest or by the inline change array, so
    // it can resolve neither - the tile it opened could only ever say
    // source-unavailable. The edit's `file_change` blocks ARE hydrated (the row
    // is on screen because they are), so it opens on those instead.
    const segment = vi.fn(() => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }));
    const cumulative = vi.fn(() => ({
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
    }));

    renderPanel({
      changes: [liveChange("/repo/src/streaming.ts")],
      activeTurnStatus: "running",
      opener: {
        segment,
        cumulative,
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle: vi.fn(() => vi.fn()),
      },
    });
    fireEvent.click(screen.getByText("1 file changed"));

    expect(segment).toHaveBeenCalledWith({
      filePath: "/repo/src/streaming.ts",
      sourceBlockIds: ["block-1"],
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
    });
    expect(cumulative).not.toHaveBeenCalled();
  });

  it("opens a host row through the cumulative tile", () => {
    // The other side of the same branch: a row a host version names resolves
    // through the cumulative surface, which is the only one that can show the
    // whole-chat before→after the panel is about.
    const segment = vi.fn(() => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }));
    const cumulative = vi.fn(() => ({
      onClick: vi.fn(),
      onDoubleClick: vi.fn(),
    }));

    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: null,
      opener: {
        segment,
        cumulative,
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle: vi.fn(() => vi.fn()),
      },
    });
    fireEvent.click(screen.getByText("1 file changed"));

    expect(cumulative).toHaveBeenCalledWith("/repo/src/app.ts");
    expect(segment).not.toHaveBeenCalled();
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

  it("withholds Review all on an OVERSHOOT, which the undelivered count reads as 0", () => {
    // The case `undeliveredChangeCount` structurally cannot report. A revert
    // lowers the host's authoritative total while the client still holds the
    // previous summary array - the replacement index-0 chunk was dropped - so
    // the delivered set is LONGER than the count and the clamp turns that into
    // `0`. Read as "complete", this action captures reverted, stale paths into
    // a durable bundle during the watchdog recovery window.
    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: null,
      opener: {
        segment: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulative: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle: vi.fn(() => vi.fn()),
      },
      undeliveredChangeCount: 0,
      accumulatedSetComplete: false,
    });

    expect(screen.queryByTestId("accumulated-review-all")).toBeNull();
  });

  it("offers Review all once the set agrees with the host's count", () => {
    // The bound: the gate must not be permanently closed by the new predicate.
    renderPanel({
      changes: [fileChange("/repo/src/app.ts")],
      activeTurnStatus: null,
      opener: {
        segment: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulative: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        hash: () => ({ onClick: vi.fn(), onDoubleClick: vi.fn() }),
        cumulativeBundle: vi.fn(() => vi.fn()),
      },
      undeliveredChangeCount: 0,
      accumulatedSetComplete: true,
    });

    expect(screen.queryByTestId("accumulated-review-all")).not.toBeNull();
  });

  it("does not claim nothing is revertible while the host holds undelivered files", async () => {
    // The panel mounts on the COUNT, so it can render with an empty delivered
    // prefix. `hasUndoable` read only the delivered rows, so in that state the
    // button was disabled under "Nothing here can be reverted." while "Undo
    // all" would in fact revert every file the host holds - and the artifact
    // opt-out beside it was already treating the same non-zero value as "the
    // set is a prefix". Two controls, one state, opposite claims.
    renderPanel({
      changes: [],
      activeTurnStatus: null,
      opener: null,
      undeliveredChangeCount: 4,
    });

    // The control stays DISABLED - no delivered row is undoable, and the
    // undelivered count is not evidence that any of them will be: it includes
    // denied and binary changes too. What must not survive is the CLAIM.
    expect(await undoAllTooltipText()).toBe(
      "Still loading the full list of changes.",
    );
  });

  it("makes the stronger claim only once the set has settled", async () => {
    renderPanel({
      changes: [{ ...fileChange("/repo/src/app.ts"), undoable: false }],
      activeTurnStatus: null,
      opener: null,
      undeliveredChangeCount: 0,
    });

    expect(await undoAllTooltipText()).toBe("Nothing here can be reverted.");
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

/**
 * The Undo-all tooltip's text.
 *
 * Radix mounts tooltip content only while open, so the label cannot be read
 * from the resting DOM - the trigger has to be focused first. The harness
 * already provides `delayDuration={0}`, so no timers are involved.
 */
async function undoAllTooltipText(): Promise<string> {
  fireEvent.focus(screen.getByTestId("accumulated-undo-all"));
  const tip = await screen.findByRole("tooltip");
  return tip.textContent;
}

function renderPanel(input: {
  readonly changes: ReadonlyArray<AccumulatedChangeRow>;
  readonly activeTurnStatus: ChatRestoreContextValue["activeTurnStatus"];
  readonly opener: ChatSnapshotDiffOpener | null;
  readonly undeliveredChangeCount?: number;
  readonly accumulatedSetComplete?: boolean;
}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatDiffTargetContext.Provider value={input.opener}>
        <ChatAccumulatedChangesPanel
          restore={{
            ...baseRestore(input.changes, input.activeTurnStatus),
            undeliveredChangeCount: input.undeliveredChangeCount ?? 0,
            // Mirrors the real relationship for the ordinary case - a prefix is
            // incomplete - while letting a test drive the OVERSHOOT, where the
            // count clamps to 0 and only this flag can tell the difference.
            accumulatedSetComplete:
              input.accumulatedSetComplete ??
              (input.undeliveredChangeCount ?? 0) === 0,
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
    accumulatedSetComplete: true,
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
    liveDiff: null,
  };
}

/**
 * The client's own row for a file the ACTIVE turn is writing - what
 * `activeTurnRow` produces. No host version names it, so it carries the
 * block-addressed `liveDiff` its segment tile opens on.
 */
function liveChange(filePath: string): AccumulatedChangeRow {
  return {
    ...fileChange(filePath),
    liveDiff: {
      sourceBlockIds: ["block-1"],
      beforeHash: "a".repeat(64),
      afterHash: "b".repeat(64),
    },
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
    liveDiff: null,
  };
}
