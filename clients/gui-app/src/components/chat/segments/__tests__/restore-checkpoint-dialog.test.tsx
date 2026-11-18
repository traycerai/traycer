import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disposeArtifactEpicSessions,
  withArtifactEpicSession,
} from "./artifact-epic-session";
import type {
  TurnCheckpointManifest,
  TurnCheckpointManifestEntry,
} from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { RestoreCheckpointDialog } from "@/components/chat/segments/restore-checkpoint-dialog";
import {
  expectFocusRingInset,
  expectScrollableDialogLayout,
} from "@/components/ui/__tests__/dialog-scroll-layout-assertions";

const MANIFEST: TurnCheckpointManifest = {
  schemaVersion: 1,
  checkpointId: "checkpoint-1",
  capturingUserId: "owner-1",
  capturingHostId: "host-1",
  allowedRoots: ["/repo"],
  workingDirectory: "/repo",
  capturedAt: 1,
  entries: [
    {
      filePath: "/repo/src/app.ts",
      operation: "edit",
      beforeHash: "before-1",
      afterHash: "after-1",
      undoable: true,
      reason: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  disposeArtifactEpicSessions();
});

describe("RestoreCheckpointDialog scroll layout", () => {
  it("keeps the file list in a scrollable body between the header and footer", () => {
    render(
      <RestoreCheckpointDialog
        open
        onOpenChange={vi.fn()}
        manifest={MANIFEST}
        hasLaterOverlappingChanges
      />,
    );

    const body = expectScrollableDialogLayout(
      screen.getByTestId("restore-checkpoint-dialog"),
    );
    expectFocusRingInset(body, ["-m-1", "px-7", "pt-1", "pb-3"]);
    expect(screen.getByText("/repo/src/app.ts")).toBeDefined();
  });
});

describe("RestoreCheckpointDialog artifact bundles", () => {
  function canvasManifest(
    undoableByFileName: Readonly<Record<string, boolean>>,
  ): TurnCheckpointManifest {
    const entries = Object.entries(undoableByFileName).map(
      ([fileName, undoable]): TurnCheckpointManifestEntry => ({
        filePath: `/repo/artifacts/board/${fileName}`,
        operation: "edit",
        beforeHash: "before",
        afterHash: "after",
        undoable,
        reason: undoable ? null : "binary",
        artifact: { artifactId: "c1", kind: "canvas", title: "Board" },
      }),
    );
    return { ...MANIFEST, entries } satisfies TurnCheckpointManifest;
  }

  function renderDialog(manifest: TurnCheckpointManifest) {
    render(
      withArtifactEpicSession(
        [],
        <RestoreCheckpointDialog
          open
          onOpenChange={vi.fn()}
          manifest={manifest}
          hasLaterOverlappingChanges={false}
        />,
      ),
    );
  }

  it("lists a canvas's files as one row and counts it as one artifact", () => {
    renderDialog(canvasManifest({ "canvas.json": true, "notes.md": true }));

    expect(screen.getByText("Board")).toBeDefined();
    expect(screen.getByText("2 files")).toBeDefined();
    expect(screen.queryByText("Skipped")).toBeNull();
    expect(screen.getByText("Also revert 1 artifact")).toBeDefined();
  });

  it("lists only the file that cannot be undone as skipped when the rest can", () => {
    renderDialog(canvasManifest({ "canvas.json": true, "notes.md": false }));

    expect(screen.getByText("Also revert 1 artifact")).toBeDefined();
    const skipped = screen.getAllByText("Skipped");
    expect(skipped).toHaveLength(1);
    const skippedRow = skipped[0].closest("div");
    expect(skippedRow?.textContent).toContain("notes.md");
    expect(skippedRow?.textContent).not.toContain("canvas.json");
  });

  it("lists every file as skipped when none of them can be undone", () => {
    renderDialog(canvasManifest({ "canvas.json": false, "notes.md": false }));

    expect(screen.getByText("2 files")).toBeDefined();
    for (const fileName of ["canvas.json", "notes.md"]) {
      const row = screen.getByText(fileName).closest("div");
      expect(within(row as HTMLElement).getByText("Skipped")).toBeDefined();
    }
    expect(screen.getAllByText("Skipped")).toHaveLength(2);
  });
});
