import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAccess } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import type { TurnCheckpointManifest } from "@traycer/protocol/persistence/epic/checkpoint-manifests";
import { ChatRestoreProvider } from "@/components/chat/chat-restore-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResolvedThemeContext } from "@/providers/use-resolved-theme";
import type { FileChangeSegment as FileChangeSegmentModel } from "@/stores/composer/chat-store";
import type { ChatRestoreSlot } from "@/stores/chats/chat-session-store";
import { FileChangeGroupSegment } from "@/components/chat/segments/file-change-group-segment";

vi.mock("@/components/diff/diff-content-primitive", () => ({
  DiffContentFrame: (props: {
    readonly sizing: string;
    readonly children: ReactNode;
  }) => (
    <div data-testid="inline-diff-frame" data-sizing={props.sizing}>
      {props.children}
    </div>
  ),
  DiffContentPrimitive: (props: {
    readonly backgrounds: boolean;
    readonly lineNumbers: boolean;
    readonly indicatorStyle: string;
  }) => (
    <div
      data-testid="inline-diff"
      data-backgrounds={String(props.backgrounds)}
      data-line-numbers={String(props.lineNumbers)}
      data-indicator-style={props.indicatorStyle}
    />
  ),
}));

// The inline diff lazy-fetches before/after by hash; stub the query so the
// expanded diff renders synchronously without a HostRuntimeProvider.
vi.mock("@/hooks/snapshots/use-snapshot-diff-query", () => ({
  useSnapshotDiffQuery: () => ({
    data: {
      beforeContent: "old();\n",
      afterContent: "const a = 1;\n",
      reason: "snapshot",
    },
    isPending: false,
  }),
}));

const FILES = [
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
  {
    id: "file-2",
    kind: "file_change",
    filePath: "/repo/src/new.ts",
    operation: "create",
    diffSource: "snapshot",
    beforeHash: null,
    afterHash: "b".repeat(64),
    additions: 1,
    deletions: 0,
    sourceBlockIds: ["file-2"],
    reason: "snapshot",
    isStreaming: false,
    endState: null,
    parentId: null,
  },
  {
    id: "file-3",
    kind: "file_change",
    filePath: "/repo/assets/logo.png",
    operation: "delete",
    diffSource: "none",
    beforeHash: null,
    afterHash: null,
    additions: 0,
    deletions: 0,
    sourceBlockIds: ["file-3"],
    reason: "not_intercepted",
    isStreaming: false,
    endState: null,
    parentId: null,
  },
] satisfies ReadonlyArray<FileChangeSegmentModel>;

const MANIFEST = {
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
    {
      filePath: "/repo/src/new.ts",
      operation: "create",
      beforeHash: null,
      afterHash: "after-2",
      undoable: true,
      reason: null,
    },
    {
      filePath: "/repo/assets/logo.png",
      operation: "delete",
      beforeHash: null,
      afterHash: null,
      undoable: false,
      reason: "binary",
    },
  ],
} satisfies TurnCheckpointManifest;

interface RenderGroupInput {
  readonly accessRole: ChatAccess["role"] | null;
  readonly currentUserId: string | null;
  readonly activeHostId: string | null;
  readonly activeTurnStatus: ChatActiveTurn["status"] | null;
  readonly localSnapshotsClearedAt: number | null;
  readonly manifest: TurnCheckpointManifest;
  readonly hasLaterOverlappingChanges: boolean;
  readonly restore: ChatRestoreSlot | null;
  readonly restoreActionPending: boolean;
  readonly restoreCheckpoint: (checkpointId: string) => string | null;
}

function renderGroup(input: RenderGroupInput) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ResolvedThemeContext.Provider
        value={{ resolvedTheme: "dark", themePreset: "traycer-green" }}
      >
        <ChatRestoreProvider
          value={{
            accessRole: input.accessRole,
            currentUserId: input.currentUserId,
            activeHostId: input.activeHostId,
            activeTurnStatus: input.activeTurnStatus,
            localSnapshotsClearedAt: input.localSnapshotsClearedAt,
            restore: input.restore,
            restoreActionPending: input.restoreActionPending,
            restoreCheckpoint: input.restoreCheckpoint,
            accumulatedFileChanges: [],
            revertFileChanges: () => null,
          }}
        >
          <FileChangeGroupSegment
            findUnitId={null}
            files={FILES}
            artifacts={[]}
            checkpointManifest={input.manifest}
            hasLaterOverlappingChanges={input.hasLaterOverlappingChanges}
          />
        </ChatRestoreProvider>
      </ResolvedThemeContext.Provider>
    </TooltipProvider>,
  );
}

function baseInput(
  restoreCheckpoint: (checkpointId: string) => string | null,
): RenderGroupInput {
  return {
    accessRole: "owner",
    currentUserId: "owner-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
    localSnapshotsClearedAt: null,
    manifest: MANIFEST,
    hasLaterOverlappingChanges: false,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint,
  };
}

async function tooltipText(): Promise<string | null> {
  fireEvent.focus(screen.getByTestId("checkpoint-undo-button"));
  return (await screen.findByRole("tooltip")).textContent;
}

function expectUndoUnavailable(): void {
  expect(
    screen
      .getByRole<HTMLButtonElement>("button", {
        name: "Undo changes",
      })
      .getAttribute("aria-disabled"),
  ).toBe("true");
}

describe("<FileChangeGroupSegment /> checkpoint undo", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("enables Undo for the owner on the capturing host", async () => {
    renderGroup(baseInput(vi.fn(() => "action-1")));

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Undo changes",
    });

    expect(button.disabled).toBe(false);
    expect(await tooltipText()).toBe("Undo this turn.");
  });

  it("disables Undo for non-owners", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      accessRole: "viewer",
    });

    expectUndoUnavailable();
    expect(await tooltipText()).toBe("Only the chat owner can restore files.");
  });

  it("disables Undo on the wrong host", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      activeHostId: "host-2",
    });

    expectUndoUnavailable();
    expect(await tooltipText()).toBe("Undo unavailable on this device.");
  });

  it("disables Undo for pre-clear local snapshot manifests", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      localSnapshotsClearedAt: MANIFEST.capturedAt,
    });

    expectUndoUnavailable();
    expect(await tooltipText()).toBe("Undo unavailable on this device.");
  });

  it("keeps Undo enabled for manifests captured after local snapshots were cleared", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      localSnapshotsClearedAt: MANIFEST.capturedAt - 1,
    });

    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: "Undo changes",
    });

    expect(button.disabled).toBe(false);
    expect(await tooltipText()).toBe("Undo this turn.");
  });

  it("disables Undo while a chat turn is active", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      activeTurnStatus: "running",
    });

    expectUndoUnavailable();
    expect(await tooltipText()).toBe(
      "Wait for the active turn to finish or stop it before restoring.",
    );
  });

  it("disables Undo when nothing is undoable", async () => {
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      manifest: {
        ...MANIFEST,
        entries: MANIFEST.entries.map((entry) => ({
          ...entry,
          beforeHash: null,
          undoable: false,
          reason: "not_intercepted",
        })),
      },
    });

    expectUndoUnavailable();
    expect(await tooltipText()).toBe("Nothing to restore.");
  });

  it("renders mixed undoability counts and dispatches restore", () => {
    const restoreCheckpoint = vi.fn(() => "restore-action-1");
    renderGroup({
      ...baseInput(restoreCheckpoint),
      hasLaterOverlappingChanges: true,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Undo changes",
      }),
    );

    expect(screen.getByTestId("restore-checkpoint-dialog")).toBeTruthy();
    expect(screen.getByText("/repo/src/app.ts")).toBeTruthy();
    expect(screen.getByText("/repo/src/new.ts")).toBeTruthy();
    expect(screen.getByText("/repo/assets/logo.png")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
    expect(screen.getByTestId("restore-cumulative-note").textContent).toContain(
      "later turns",
    );
    expect(screen.getByTestId("restore-summary").textContent).toContain(
      "Restoring",
    );
    expect(screen.getByTestId("restore-summary").textContent).toContain("2");
    expect(screen.getByTestId("restore-summary").textContent).toContain(
      "1 cannot be undone",
    );

    fireEvent.click(screen.getByTestId("restore-confirm"));

    expect(restoreCheckpoint).toHaveBeenCalledWith("turn-1", true);
  });

  it("hides net-zero entries from the modal and excludes them from the count", () => {
    // A file the turn touched but left byte-identical (before === after) is not
    // a change of this turn: the "Changes" group already drops it on the file
    // side, so the modal must not list it or count it either.
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      manifest: {
        ...MANIFEST,
        entries: [
          {
            filePath: "/repo/src/app.ts",
            operation: "edit",
            beforeHash: "before-1",
            afterHash: "after-1",
            undoable: true,
            reason: null,
          },
          {
            filePath: "/repo/src/touched-noop.ts",
            operation: "edit",
            beforeHash: "same-hash",
            afterHash: "same-hash",
            undoable: true,
            reason: null,
          },
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo changes" }));

    expect(screen.getByTestId("restore-checkpoint-dialog")).toBeTruthy();
    // The real change is listed; the net-zero touch is not.
    expect(screen.getByText("/repo/src/app.ts")).toBeTruthy();
    expect(screen.queryByText("/repo/src/touched-noop.ts")).toBeNull();
    // "Restoring 1 file ..." - the no-op is excluded from the count.
    const summary = screen.getByTestId("restore-summary").textContent;
    expect(summary).toContain("Restoring");
    expect(summary).toContain("1 file to the state at the start of this turn");
    expect(summary).not.toContain("2");
  });

  it("offers no Undo button when every entry is a net-zero no-op", () => {
    // Defensive: a turn whose manifest holds only no-op touches has nothing to
    // undo, so the action must not render at all (it normally wouldn't even
    // reach a "Changes" group, but enablement must agree regardless).
    renderGroup({
      ...baseInput(vi.fn(() => "action-1")),
      manifest: {
        ...MANIFEST,
        entries: [
          {
            filePath: "/repo/src/touched-noop.ts",
            operation: "edit",
            beforeHash: "same-hash",
            afterHash: "same-hash",
            undoable: true,
            reason: null,
          },
        ],
      },
    });

    expect(screen.queryByRole("button", { name: "Undo changes" })).toBeNull();
  });

  it("expands file diffs at full height with changed-line backgrounds and gutter", () => {
    renderGroup(baseInput(vi.fn(() => "action-1")));

    fireEvent.click(screen.getByText("Changes"));
    const groupBody = screen.getByTestId("file-change-group-body");
    expect(groupBody.className).not.toContain("max-h-");
    expect(groupBody.className).not.toContain("overflow-y-auto");

    const fileHeader = screen.getByText("/repo/src/app.ts").closest("button");
    if (fileHeader === null) throw new Error("Missing file-change row header");
    fireEvent.click(fileHeader);

    expect(fileHeader.className).toContain("sticky");
    expect(fileHeader.className).toContain("bg-background");
    expect(fileHeader.className).not.toContain("backdrop-blur");
    const diff = screen.getByTestId("inline-diff");
    expect(diff.getAttribute("data-backgrounds")).toBe("true");
    expect(diff.getAttribute("data-line-numbers")).toBe("false");
    expect(diff.getAttribute("data-indicator-style")).toBe("bars");
    expect(screen.getByTestId("inline-diff-frame").dataset.sizing).toBe(
      "content",
    );
  });
});
