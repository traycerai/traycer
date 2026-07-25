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
import {
  act,
  cleanup,
  render as testingRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domAnimation, LazyMotion } from "motion/react";
import type { ReactElement } from "react";
import { create } from "zustand";

// Count every render of the composer subtree by stubbing the leaf `ChatComposer`.
// `ChatComposerRegion` is the memo boundary, so a render here == a boundary render.
let composerRenderCount = 0;
vi.mock("@/components/chat/composer/chat-composer", () => ({
  ChatComposer: (props: {
    readonly workspaceControls: import("react").ReactNode | null;
  }) => {
    composerRenderCount += 1;
    return <div data-testid="composer-stub">{props.workspaceControls}</div>;
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
import { ContextUsageChip } from "@/components/chat/context-usage-chip";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettingsStore } from "@/stores/settings/settings-store";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";

const USAGE_PROBE_75: TokenUsage = {
  inputTokens: 50_000,
  outputTokens: 1_000,
  totalTokens: 51_000,
  contextTokens: 50_000,
  contextWindow: 200_000,
};

const USAGE_PROBE_25: TokenUsage = {
  inputTokens: 150_000,
  outputTokens: 2_000,
  totalTokens: 152_000,
  contextTokens: 150_000,
  contextWindow: 200_000,
};
const EMPTY_BACKGROUND_STOP_TASK_IDS: ReadonlySet<string> = new Set();

interface UsageProbeState {
  readonly usage: TokenUsage;
  readonly setUsage: (usage: TokenUsage) => void;
}

const useUsageProbeStore = create<UsageProbeState>()((set) => ({
  usage: USAGE_PROBE_75,
  setUsage: (usage) => set({ usage }),
}));

function render(ui: ReactElement) {
  const result = testingRender(
    <TooltipProvider delayDuration={0}>
      <LazyMotion features={domAnimation}>{ui}</LazyMotion>
    </TooltipProvider>,
  );
  return {
    ...result,
    rerender: (nextUi: ReactElement) =>
      result.rerender(
        <TooltipProvider delayDuration={0}>
          <LazyMotion features={domAnimation}>{nextUi}</LazyMotion>
        </TooltipProvider>,
      ),
  };
}

function queryCompactContextTrigger() {
  return screen.queryByRole("button", {
    name: /open context usage breakdown/i,
  });
}

function UsageLeafProbe() {
  const usage = useUsageProbeStore((s) => s.usage);
  return <ContextUsageChip usage={usage} />;
}

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
  isBusy: false,
  onAnswer: () => null,
  onError: () => null,
  onFork: null,
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
  onPause: () => null,
  onResume: () => null,
  onEdit: () => undefined,
  onCancel: () => undefined,
  onAbortSteer: () => undefined,
  onCancelEdit: () => undefined,
  onStopBackgroundItem: () => null,
  onStopAllBackgroundItems: () => null,
  onReorder: () => undefined,
  onSteerNow: () => undefined,
};
const COMPOSER: ChatLowerComposerState = {
  sessionSettingsSeed: null,
  fallbackSettingsSeed: null,
  nodeId: "chat-1",
  isActive: true,
  mentionRoots: [],
  fallbackToGlobalMentionRoots: true,
  currentEpicId: "epic-1",
  onSubmitMessage: () => false,
  onSettingsChange: null,
  workspaceControls: (
    <>
      <span data-testid="worktree-chip" />
      <UsageLeafProbe />
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
    backgroundItems: undefined,
    backgroundStopPendingTaskIds: EMPTY_BACKGROUND_STOP_TASK_IDS,
    backgroundStopAllPending: false,
    onBackgroundItemClick: () => undefined,
  };
}

describe("composer isolation from per-token dock churn", () => {
  beforeEach(() => {
    composerRenderCount = 0;
    useUsageProbeStore.setState({ usage: USAGE_PROBE_75 });
    useSettingsStore.setState({ pinContextUsageBreakdown: false });
  });

  afterEach(cleanup);

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

  it("does not re-render the composer when the context usage leaf updates", async () => {
    useSettingsStore.getState().setPinContextUsageBreakdown(true);
    render(<ChatLowerInteractionSurfaces {...props(TURN_IDLE, 0)} />);
    expect(composerRenderCount).toBe(1);
    expect(queryCompactContextTrigger()).toBeNull();
    expect(
      screen.getByTestId("context-usage-pinned-percent-value").textContent,
    ).toBe("75");
    expect(screen.getByText("50K / 200K used")).toBeTruthy();

    act(() => {
      useUsageProbeStore.getState().setUsage(USAGE_PROBE_25);
    });

    expect(composerRenderCount).toBe(1);
    expect(queryCompactContextTrigger()).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByTestId("context-usage-pinned-percent-value").textContent,
      ).toBe("25");
    });
    expect(screen.getByText("150K / 200K used")).toBeTruthy();
  });
});
