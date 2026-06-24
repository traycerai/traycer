/**
 * Composer render-count regression: the composer subtree must NOT re-render when
 * only the per-token, message-derived dock inputs (`todo` / `restoreContext`)
 * change. Those flow to `ChatLowerDock` (which SHOULD re-render every streaming
 * token); the composer's inputs are all non-streaming, so the `ChatComposerRegion`
 * memo boundary should skip. This test proves the boundary holds and is not
 * frozen (it still re-renders when a real composer input changes).
 *
 * The composer-relevant props are held as stable references here exactly as the
 * real view-model memoizes them; only `todo` / `restoreContext` change between
 * simulated tokens.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Count every render of the composer subtree by stubbing the leaf `ChatComposer`.
// `ChatComposerRegion` is the memo boundary, so a render here == a boundary render.
let composerRenderCount = 0;
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: () => {
    composerRenderCount += 1;
    return <div data-testid="composer-stub" />;
  },
}));
// The dock legitimately re-renders per token; stub it so the test isolates the
// composer boundary (and to avoid the dock's epic-session/query dependencies).
vi.mock("@/components/chat/chat-lower-dock", () => ({
  ChatLowerDock: () => <div data-testid="dock-stub" />,
}));
vi.mock("@/components/chat/chat-stop-children-dialog", () => ({
  StopChildrenDialog: () => null,
}));
vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));
vi.mock("@/hooks/agent/use-stop-agent-mutation", () => ({
  useAgentStop: () => ({ mutate: () => undefined }),
}));

import {
  ChatLowerInteractionSurfaces,
  type ChatLowerInteractionSurfacesProps,
  type ChatLowerRuntimeState,
  type ChatLowerAccessState,
  type ChatLowerTurnState,
  type ChatLowerInterviewState,
  type ChatLowerApprovalsState,
  type ChatLowerQueueState,
  type ChatLowerComposerState,
} from "@/components/epic-canvas/renderers/chat-tile-lower-surfaces";
import { WORKSPACE_COMPOSER_READY } from "@/lib/composer/workspace-composer-availability";
import type { ChatRestoreContextValue } from "@/components/chat/chat-restore-context-core";
import type { PinnedTodoSnapshot } from "@/components/chat/chat-pinned-todos";

// ── Stable composer-relevant props (built once, never re-identified) ──────────
const RUNTIME: ChatLowerRuntimeState = {
  snapshotLoaded: true,
};
const ACCESS: ChatLowerAccessState = { isViewer: false, canAct: true };
const TURN_IDLE: ChatLowerTurnState = {
  activeTurnStatus: null,
  stopDisabled: true,
  onStopTurn: () => null,
};
const TURN_RUNNING: ChatLowerTurnState = {
  activeTurnStatus: "running",
  stopDisabled: false,
  onStopTurn: () => null,
};
const INTERVIEW: ChatLowerInterviewState = {
  pending: null,
  onAnswer: () => null,
  onError: () => null,
};
const APPROVALS: ChatLowerApprovalsState = {
  pendingFileEditApprovals: [],
  pendingApprovals: [],
  onFileEditDecision: () => undefined,
  onApprovalDecision: () => undefined,
};
const QUEUE: ChatLowerQueueState = {
  editingItem: null,
  editingItemId: null,
  value: { status: "idle", items: [] },
  onResume: () => null,
  onEdit: () => undefined,
  onCancel: () => undefined,
  onAbortSteer: () => undefined,
  onCancelEdit: () => undefined,
  onReorder: () => undefined,
  onSteerNow: () => undefined,
};
const COMPOSER: ChatLowerComposerState = {
  sessionSettingsSeed: null,
  fallbackSettingsSeed: null,
  nodeId: "chat-1",
  isActive: true,
  mentionRoots: [],
  currentEpicId: "epic-1",
  onSubmitMessage: () => false,
  onSettingsChange: null,
  workspaceControls: (
    <>
      <span data-testid="worktree-chip" />
      <span data-testid="usage-chip" />
    </>
  ),
  workspaceAvailability: WORKSPACE_COMPOSER_READY,
};

// ── Per-token (dock-only) inputs: fresh identity each token, like the real app ─
function restoreContext(): ChatRestoreContextValue {
  return {
    accessRole: "owner",
    currentUserId: "user-1",
    activeHostId: "host-1",
    activeTurnStatus: null,
    localSnapshotsClearedAt: null,
    restore: null,
    restoreActionPending: false,
    restoreCheckpoint: () => null,
    accumulatedFileChanges: [],
    revertFileChanges: () => null,
  };
}
// `todo` stays non-null so `pinnedStackVisible` (and the composer layout) is
// stable while it churns; any composer re-render is then attributable to the
// memo boundary, not a layout change.
function todoSnapshot(id: string): PinnedTodoSnapshot {
  return { id, items: [] };
}

function props(
  turn: ChatLowerTurnState,
  token: number,
): ChatLowerInteractionSurfacesProps {
  return {
    epicId: "epic-1",
    chatId: "chat-1",
    runtime: RUNTIME,
    access: ACCESS,
    turn,
    interview: INTERVIEW,
    approvals: APPROVALS,
    queue: QUEUE,
    composer: COMPOSER,
    todo: todoSnapshot(`token-${token}`),
    restoreContext: restoreContext(),
  };
}

describe("composer isolation from per-token dock churn", () => {
  beforeEach(() => {
    composerRenderCount = 0;
  });

  it("does not re-render the composer when only todo/restoreContext change", () => {
    const { rerender } = render(
      <ChatLowerInteractionSurfaces {...props(TURN_IDLE, 0)} />,
    );
    expect(composerRenderCount).toBe(1);

    // Simulate 5 streaming tokens: each swaps the dock's message-derived inputs
    // (new `todo` + `restoreContext` identities); every composer-relevant prop
    // keeps its reference.
    for (let token = 1; token <= 5; token += 1) {
      rerender(<ChatLowerInteractionSurfaces {...props(TURN_IDLE, token)} />);
    }

    // Composer subtree rendered exactly once across all "tokens".
    expect(composerRenderCount).toBe(1);
  });

  it("re-renders the composer when a real composer input changes (not frozen)", () => {
    const { rerender } = render(
      <ChatLowerInteractionSurfaces {...props(TURN_IDLE, 0)} />,
    );
    expect(composerRenderCount).toBe(1);

    // Run status flips idle -> running: a genuine composer input change.
    rerender(<ChatLowerInteractionSurfaces {...props(TURN_RUNNING, 1)} />);
    expect(composerRenderCount).toBe(2);
  });
});
