import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AccumulatedChangeRow } from "@/lib/chat/accumulated-change-rows";
import type { CheckpointFileOperation } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { ChatAccumulatedChangesPanel } from "@/components/chat/chat-accumulated-changes-panel";
import { ChatDiffTargetContext } from "@/components/chat/chat-diff-target";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * With no `<EpicSessionContext>` above it (the layout editor's sample
 * workspace draws this panel that way, mirroring
 * `sample-workspace-scene.ts`'s `SAMPLE_RESTORE`), `ArtifactAccumulatedHeader`
 * gates `useArtifactRowDisplay` behind `EpicSessionGate` and falls back to
 * `sessionlessArtifactRowDisplay`, which reads the row's own captured
 * `CheckpointArtifactTag` instead of the live open-epic projection. Nothing
 * here is mocked: `@/lib/epic-selectors` runs for real, so this is the
 * regression the real hooks used to throw on.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<ChatAccumulatedChangesPanel /> with no open epic session", () => {
  it("shows the captured artifact title with no throw and no open affordance", () => {
    renderPanel([artifactChange("edit")]);
    openPanel();

    const title = screen.getByText("Onboarding flow spec");
    const titleWrapper = title.parentElement;
    expect(titleWrapper?.getAttribute("role")).toBeNull();
    expect(titleWrapper?.className).not.toMatch(/line-through/);
  });

  it("strikes the title through for a delete operation", () => {
    renderPanel([artifactChange("delete")]);
    openPanel();

    const title = screen.getByText("Onboarding flow spec");
    expect(title.parentElement?.className).toMatch(/line-through/);
  });
});

function renderPanel(changes: ReadonlyArray<AccumulatedChangeRow>) {
  return render(
    <TooltipProvider delay={0}>
      <ChatDiffTargetContext.Provider value={null}>
        <ChatAccumulatedChangesPanel
          restore={baseRestore(changes)}
          separated={false}
        />
      </ChatDiffTargetContext.Provider>
    </TooltipProvider>,
  );
}

/**
 * The panel is collapsed by default, and `CollapsibleContent` (Radix) does
 * not mount its children while closed - so the row (and this test's title
 * text) is not in the DOM until the header is clicked open.
 */
function openPanel(): void {
  fireEvent.click(screen.getByTestId("accumulated-changes-summary"));
}

function baseRestore(
  changes: ReadonlyArray<AccumulatedChangeRow>,
): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
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

/**
 * An artifact row shaped like what a turn's checkpoint manifest and
 * `depictChangedFiles` (layout editor) both feed the panel: `filePath` is the
 * artifact's `index.md`, and `artifact` is the captured tag the fallback
 * display reads its title from.
 */
function artifactChange(
  operation: CheckpointFileOperation,
): AccumulatedChangeRow {
  return {
    filePath: "/repo/.traycer/epics/epic-1/artifacts/onboarding-flow/index.md",
    operation,
    diffSource: "snapshot",
    reason: "snapshot",
    undoable: true,
    artifact: {
      artifactId: "artifact-1",
      kind: "spec",
      title: "Onboarding flow spec",
    },
    counts: { additions: 1, deletions: 1 },
    hasContents: true,
    digest: null,
    liveDiff: null,
  };
}
