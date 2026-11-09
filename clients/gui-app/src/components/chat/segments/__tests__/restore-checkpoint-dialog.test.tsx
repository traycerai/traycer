import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnCheckpointManifest } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
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
