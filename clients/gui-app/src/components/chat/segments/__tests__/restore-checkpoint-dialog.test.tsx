import { cleanup, render, screen } from "@testing-library/react";
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
  function canvasManifest(undoable: boolean): TurnCheckpointManifest {
    const canvasFile = (fileName: string): TurnCheckpointManifestEntry => ({
      filePath: `/repo/artifacts/board/${fileName}`,
      operation: "edit",
      beforeHash: "before",
      afterHash: "after",
      undoable,
      reason: undoable ? null : "binary",
      artifact: { artifactId: "c1", kind: "canvas", title: "Board" },
    });
    return {
      ...MANIFEST,
      entries: [canvasFile("canvas.json"), canvasFile("notes.md")],
    } satisfies TurnCheckpointManifest;
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
    renderDialog(canvasManifest(true));

    expect(screen.getByText("Board")).toBeDefined();
    expect(screen.getByText("2 files")).toBeDefined();
    expect(screen.queryByText("Skipped")).toBeNull();
    expect(screen.getByText("Also revert 1 artifact")).toBeDefined();
  });

  it("marks a bundle none of whose files can be undone as skipped", () => {
    renderDialog(canvasManifest(false));

    expect(screen.getByText("2 files")).toBeDefined();
    expect(screen.getByText("Skipped")).toBeDefined();
  });
});
