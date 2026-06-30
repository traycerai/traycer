// Pins undo gating's independence from permission mode by structure:
// `FileChangeGroupSegment` takes no permission-mode prop. Paired with
// `permission-diff-undo-e2e.test.ts` which covers diff emission.
import { describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { TurnCheckpointManifest } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { ChatRestoreProvider } from "@/components/chat/chat-restore-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileChangeGroupSegment } from "@/components/chat/segments/file-change-group-segment";
import type { FileChangeSegment as FileChangeSegmentModel } from "@/stores/composer/chat-store";
import type { ChatRestoreSlot } from "@/stores/chats/chat-session-store";
import type {
  ChatAccess,
  ChatActiveTurn,
} from "@traycer/protocol/host/agent/gui/subscribe";

const PERMISSION_MODES = [
  "supervised",
  "auto_accept_edits",
  "full_access",
] as const;
type PermissionMode = (typeof PERMISSION_MODES)[number];

const FILES: ReadonlyArray<FileChangeSegmentModel> = [
  {
    id: "file-1",
    kind: "file_change",
    filePath: "/repo/src/app.ts",
    operation: "edit",
    diffSource: "snapshot",
    beforeHash: "a".repeat(64),
    afterHash: "b".repeat(64),
    additions: 1,
    deletions: 1,
    sourceBlockIds: ["file-1"],
    reason: "snapshot",
    isStreaming: false,
    endState: null,
    parentId: null,
  },
];

const UNDOABLE_MANIFEST: TurnCheckpointManifest = {
  schemaVersion: 1,
  checkpointId: "turn-1",
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

interface RenderArgs {
  readonly manifest: TurnCheckpointManifest | null;
  readonly accessRole: ChatAccess["role"] | null;
  readonly activeHostId: string | null;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
}

function renderSegment(args: RenderArgs) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ChatRestoreProvider
        value={{
          accessRole: args.accessRole,
          currentUserId: "owner-1",
          activeHostId: args.activeHostId,
          activeTurnStatus: args.activeTurnStatus,
          localSnapshotsClearedAt: null,
          restore: null as ChatRestoreSlot | null,
          restoreActionPending: false,
          restoreCheckpoint: vi.fn().mockReturnValue(null),
          accumulatedFileChanges: [],
          revertFileChanges: vi.fn().mockReturnValue(null),
        }}
      >
        <FileChangeGroupSegment
          findUnitId={null}
          files={FILES}
          artifacts={[]}
          checkpointManifest={args.manifest}
          hasLaterOverlappingChanges={false}
        />
      </ChatRestoreProvider>
    </TooltipProvider>,
  );
}

function gatherUndoState(): {
  readonly visible: boolean;
  readonly disabled: boolean;
} {
  const button = screen.queryByTestId("checkpoint-undo-button");
  if (button === null) return { visible: false, disabled: false };
  return {
    visible: true,
    disabled: button.getAttribute("aria-disabled") === "true",
  };
}

describe("file-change undo button - permission-mode independence", () => {
  describe.each(PERMISSION_MODES)(
    "permission mode: %s",
    (_mode: PermissionMode) => {
      it("shows the undo button when checkpointManifest is present and owner is on the capturing host", () => {
        renderSegment({
          manifest: UNDOABLE_MANIFEST,
          accessRole: "owner",
          activeHostId: "host-1",
          activeTurnStatus: null,
        });
        const state = gatherUndoState();
        expect(state.visible).toBe(true);
        expect(state.disabled).toBe(false);
        cleanup();
      });

      it("hides the undo button when there is no checkpoint manifest (the permission mode is irrelevant)", () => {
        renderSegment({
          manifest: null,
          accessRole: "owner",
          activeHostId: "host-1",
          activeTurnStatus: null,
        });
        expect(gatherUndoState().visible).toBe(false);
        cleanup();
      });

      it("disables the undo button when a turn is currently active", () => {
        renderSegment({
          manifest: UNDOABLE_MANIFEST,
          accessRole: "owner",
          activeHostId: "host-1",
          activeTurnStatus: "running",
        });
        const state = gatherUndoState();
        expect(state.visible).toBe(true);
        expect(state.disabled).toBe(true);
        cleanup();
      });

      it("disables the undo button when the active host does not match the capturing host", () => {
        renderSegment({
          manifest: UNDOABLE_MANIFEST,
          accessRole: "owner",
          activeHostId: "host-other",
          activeTurnStatus: null,
        });
        const state = gatherUndoState();
        expect(state.visible).toBe(true);
        expect(state.disabled).toBe(true);
        cleanup();
      });

      it("renders the changes block (file_change segment) even without a checkpoint manifest", () => {
        renderSegment({
          manifest: null,
          accessRole: "owner",
          activeHostId: "host-1",
          activeTurnStatus: null,
        });
        // The "Changes" header is rendered by FileChangeGroupSegment for every
        // mode - there is no permission-mode gate on the block itself.
        expect(screen.getByText("Changes")).not.toBeNull();
        cleanup();
      });
    },
  );
});
