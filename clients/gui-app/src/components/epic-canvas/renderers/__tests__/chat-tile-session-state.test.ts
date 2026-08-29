import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ExternalToast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { AccountContext } from "@traycer/protocol/common/schemas";
import type { Message } from "@traycer/protocol/persistence/epic/schemas";
import type { TokenUsage } from "@traycer/protocol/persistence/epic/foundation";
import type { ChatTranscriptDerived } from "@traycer/protocol/host/agent/gui/subscribe-windowed";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";
import type {
  ChatMessage,
  InterviewSegment,
} from "@/stores/composer/chat-store";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

const toastSuccess = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "success-toast",
  ),
);
const toastWarning = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "warning-toast",
  ),
);
const toastInfo = vi.hoisted(() =>
  vi.fn<(message: ReactNode, options: ExternalToast | undefined) => string>(
    () => "info-toast",
  ),
);

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    warning: toastWarning,
    info: toastInfo,
  },
}));

import {
  canModifyChatMessages,
  chatActivityIndicator,
  chatMessageEditingForInlineEdit,
  findPendingInterview,
  findUnanswerableInterviews,
  resolvedTurnStatus,
  selectContextUsage,
  shouldGenerateChatTitleForSubmittedMessage,
  showRestoreResultToast,
  type InlineEditState,
} from "../chat-tile-session-state";
import type {
  ChatSessionState,
  PendingUserMessage,
} from "@/stores/chats/chat-session-store";

beforeEach(() => {
  toastSuccess.mockClear();
  toastWarning.mockClear();
  toastInfo.mockClear();
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

afterEach(() => {
  useDesktopDialogStore.setState({
    activeDialog: null,
    reportIssueAvailable: false,
    reportIssueContext: null,
    reportIssueDraftId: 0,
  });
});

const CONTENT: JsonContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "hello" }],
    },
  ],
};

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

const MESSAGE: ChatMessage = {
  id: "message-1",
  role: "user",
  content: "hello",
  segments: [],
  structuredContent: CONTENT,
  attachments: [],
  settings: null,
  createdAt: 0,
  completedAt: null,
  stopped: null,
  persistentMessageId: "persisted-message-1",
  senderLabel: null,
  assistantMeta: null,
  statusLabel: null,
  agentSenderInfo: null,
  agentMessage: null,
  runState: null,
  sessionAnchor: null,
  steerBadge: null,
};

function inlineEditState(dirty: boolean): InlineEditState {
  return {
    targetMessageId: "persisted-message-1",
    originalMessage: MESSAGE,
    initialContent: CONTENT,
    currentContent: CONTENT,
    dirty,
    pendingClientActionId: null,
    pendingMessageId: null,
  };
}

function renderInlineEdit(dirty: boolean) {
  const editing = chatMessageEditingForInlineEdit({
    editing: inlineEditState(dirty),
    canModifyMessages: true,
    editSettings: SETTINGS,
    mentionRoots: [],
    fallbackToGlobalMentionRoots: true,
    currentEpicId: "epic-1",
    onSnapshot: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  });

  if (editing === null) {
    throw new Error("Expected inline edit view model");
  }
  return editing;
}

describe("chatMessageEditingForInlineEdit", () => {
  it("allows resubmitting unchanged non-empty content", () => {
    expect(renderInlineEdit(false).canSubmit).toBe(true);
    expect(renderInlineEdit(true).canSubmit).toBe(true);
  });

  it("carries the workspace fallback policy into the inline editor", () => {
    expect(renderInlineEdit(false).fallbackToGlobalMentionRoots).toBe(true);
  });
});

describe("showRestoreResultToast", () => {
  const FAILED_RESULT = {
    filePath: "/Users/alice/private-project/secrets.txt",
    status: "failed" as const,
    operation: "edit" as const,
    reason: "Restore rejected for token sk-secret-123",
  };

  it("keeps Show details primary and adds a privacy-safe secondary report action", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    showRestoreResultToast([FAILED_RESULT]);

    const options = readWarningOptions();
    expect(toastWarning.mock.lastCall?.[0]).toBe(
      "0 restored, 0 skipped, 1 failed",
    );
    expectToastAction(options.action, "Show details");
    expectToastAction(options.cancel, "Report issue");
    clickToastAction(options.action, "Show details");
    expect(toastInfo).toHaveBeenCalledWith("Restore details", {
      description:
        "failed: /Users/alice/private-project/secrets.txt (Restore rejected for token sk-secret-123)",
    });

    clickToastAction(options.cancel, "Report issue");
    expect(useDesktopDialogStore.getState().reportIssueContext).toEqual({
      title: "File restore incomplete",
      message: null,
      code: null,
      source: "File restore",
    });
    expect(
      JSON.stringify(useDesktopDialogStore.getState().reportIssueContext),
    ).not.toMatch(/alice|private-project|secrets\.txt|sk-secret-123/);
  });

  it("keeps Show details but omits reporting when capability is unavailable", () => {
    showRestoreResultToast([FAILED_RESULT]);

    const options = readWarningOptions();
    expect(toastWarning.mock.lastCall?.[0]).toBe(
      "0 restored, 0 skipped, 1 failed",
    );
    expectToastAction(options.action, "Show details");
    expect(options.cancel).toBeUndefined();
  });

  it("leaves skipped-only restore notifications on the success path", () => {
    useDesktopDialogStore.setState({ reportIssueAvailable: true });

    showRestoreResultToast([
      {
        filePath: "/Users/alice/private-project/unchanged.txt",
        status: "skipped",
        operation: "edit",
        reason: "Already matches",
      },
    ]);

    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastSuccess.mock.lastCall?.[0]).toBe(
      "0 restored, 1 skipped, 0 failed",
    );
    const options = toastSuccess.mock.lastCall?.[1];
    if (options === undefined) {
      throw new Error("Expected success toast options.");
    }
    expectToastAction(options.action, "Show details");
    expect(options).not.toHaveProperty("cancel");
  });
});

function readWarningOptions(): ExternalToast {
  const options = toastWarning.mock.lastCall?.[1];
  if (options === undefined) {
    throw new Error("Expected warning toast options.");
  }
  return options;
}

function clickToastAction(
  action: ExternalToast["action"],
  label: string,
): void {
  if (typeof action !== "object" || action === null || !("onClick" in action)) {
    throw new Error(`Expected ${label} action.`);
  }
  action.onClick({} as ReactMouseEvent<HTMLButtonElement>);
}

function expectToastAction(
  action: ExternalToast["action"],
  label: string,
): void {
  if (typeof action !== "object" || action === null || !("label" in action)) {
    throw new Error(`Expected ${label} action.`);
  }
  expect(action.label).toBe(label);
}

const ACTIVE_TURN: ChatActiveTurn = {
  agentMode: "regular",
  sameTurnSteeringSupported: false,
  turnId: "turn-1",
  status: "running",
  harnessId: "codex",
  model: "codex-test",
  reasoningEffort: null,
  serviceTier: null,
  profileId: null,
  userMessageId: "message-1",
  startedAt: 0,
  updatedAt: 0,
};

const EMPTY_QUEUE: ChatQueueState = { status: "idle", items: [] };

function runnableQueue(itemCount: number): ChatQueueState {
  return {
    status: "running",
    items: Array.from({ length: itemCount }, (_, index) => ({
      kind: "prompt" as const,
      queueItemId: `item-${index}`,
      messageId: `message-${index}`,
      message: {
        kind: "user" as const,
        content: CONTENT,
        browserAnnotations: [],
      },
      sender: { type: "user" as const, userId: "owner-1" },
      settings: SETTINGS,
      accountContext: { type: "PERSONAL" as const },
      delivery: "next_turn" as const,
      status: "pending" as const,
      targetTurnId: null,
      steerRequest: null,
      fallbackReason: null,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

describe("resolvedTurnStatus - no turnInProgress from the host (older-host fallback heuristic)", () => {
  it("passes null through unchanged (idle chat)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        null,
      ),
    ).toBeNull();
  });

  it("returns the turn status when a turn is genuinely active", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("returns the turn status when a turn is genuinely active even alongside a queued item or background work", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: runnableQueue(1),
          backgroundItems: [
            {
              taskId: "t1",
              kind: "subagent",
              title: "Sub",
              blockId: "t1",
              parentTaskId: null,
              scheduledFor: null,
            },
          ],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("falls back to null when runStatus is running purely because of a pending queued item (no active turn)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("falls back to null when runStatus is running purely because of visible background work (no active turn) - the reported regression", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: [
            {
              taskId: "t1",
              kind: "subagent",
              title: "Sub",
              blockId: "t1",
              parentTaskId: null,
              scheduledFor: null,
            },
          ],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("keeps the turn status when running is explained by neither the queue nor background work (the pre-turn activating window)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("a paused queue with pending items does not count as runnable", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: { status: "paused", items: runnableQueue(1).items },
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("an empty backgroundItems array does not count as visible background work", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: [],
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("known gap: a turn still activating with another item queued behind it is (incorrectly) treated as not active", () => {
    // Documents the precision gap the host-sent `turnInProgress` layer
    // exists to close - see the next describe block.
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: undefined,
        },
        "running",
      ),
    ).toBeNull();
  });
});

describe("resolvedTurnStatus - turnInProgress present (host-sent, exact)", () => {
  it("turnInProgress: true overrides the heuristic even when it would say not-active (closes the activating+queued-behind gap)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: runnableQueue(1),
          backgroundItems: undefined,
          turnInProgress: true,
        },
        "running",
      ),
    ).toBe("running");
  });

  it("turnInProgress: false overrides the heuristic even when it would say active (background-only phase)", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: false,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("turnInProgress: false wins even when activeTurn is (unexpectedly) non-null", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: ACTIVE_TURN,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: false,
        },
        "running",
      ),
    ).toBeNull();
  });

  it("null turnStatus (already idle) short-circuits regardless of turnInProgress", () => {
    expect(
      resolvedTurnStatus(
        {
          activeTurn: null,
          queue: EMPTY_QUEUE,
          backgroundItems: undefined,
          turnInProgress: true,
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("chatActivityIndicator", () => {
  const MONITOR_ITEM = {
    taskId: "t1",
    kind: "monitor" as const,
    title: "Monitor",
    blockId: "t1",
    parentTaskId: null,
    scheduledFor: null,
  };

  type ActivityState = Parameters<typeof chatActivityIndicator>[0];

  function activityState(overrides: Partial<ActivityState>): ActivityState {
    return {
      runStatus: "idle",
      activeTurn: null,
      queue: EMPTY_QUEUE,
      backgroundItems: [],
      turnInProgress: false,
      managedCommands: [],
      ...overrides,
    };
  }

  function shell(status: ManagedCommand["status"]): ManagedCommand {
    return {
      id: "cmd-1",
      monitoring: false,
      description: "dev server",
      command: "bun run dev",
      cwd: "/work/repo",
      cadence: null,
      status,
      chatId: "chat-1",
      createdAtMs: 1,
      updatedAtMs: 1,
    };
  }

  it("reads null for an idle chat", () => {
    expect(chatActivityIndicator(activityState({}))).toBeNull();
  });

  it("reads turn while the host reports a genuine turn in progress", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          activeTurn: ACTIVE_TURN,
          turnInProgress: true,
        }),
      ),
    ).toBe("turn");
  });

  it("reads background when only a Monitor/background task keeps the chat non-idle", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          backgroundItems: [MONITOR_ITEM],
        }),
      ),
    ).toBe("background");
  });

  it("reads turn (not background) while a detached subagent is still running", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          backgroundItems: [
            {
              taskId: "t2",
              kind: "subagent" as const,
              title: "Explore the codebase",
              blockId: "t2",
              parentTaskId: null,
              scheduledFor: null,
            },
          ],
        }),
      ),
    ).toBe("turn");
  });

  it("reads turn (not background) while a detached workflow fleet is still running", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          backgroundItems: [
            MONITOR_ITEM,
            {
              taskId: "workflow-task",
              kind: "workflow" as const,
              title: "review-changes",
              blockId: "workflow-task",
              parentTaskId: null,
              phase: null,
              activeLabel: null,
              agentsStarted: null,
              agentsFinished: null,
            },
          ],
        }),
      ),
    ).toBe("turn");
  });

  it("prioritizes the turn when a turn and background work run simultaneously", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          activeTurn: ACTIVE_TURN,
          backgroundItems: [MONITOR_ITEM],
          turnInProgress: true,
        }),
      ),
    ).toBe("turn");
  });

  it("reads turn (not background) while a runnable queue drains between turns", () => {
    expect(
      chatActivityIndicator(
        activityState({ runStatus: "running", queue: runnableQueue(1) }),
      ),
    ).toBe("turn");
  });

  it("keeps the stopping phase on the turn tier", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "stopping",
          activeTurn: ACTIVE_TURN,
          turnInProgress: true,
        }),
      ),
    ).toBe("turn");
  });

  it("falls back to the older-host heuristic when turnInProgress is absent", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          backgroundItems: [MONITOR_ITEM],
          turnInProgress: undefined,
        }),
      ),
    ).toBe("background");
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          backgroundItems: undefined,
          turnInProgress: undefined,
        }),
      ),
    ).toBe("turn");
  });

  it("reads background for a running shell while the agent itself is idle", () => {
    // A shell outlives the turn that started it, so `runStatus` is back to
    // "idle" while the process is still live - the chat must not read idle.
    expect(
      chatActivityIndicator(
        activityState({
          managedCommands: [
            shell({ state: "running", pid: 4242, startedAtMs: 1 }),
          ],
        }),
      ),
    ).toBe("background");
  });

  it("reads null once the chat's only shell has exited", () => {
    expect(
      chatActivityIndicator(
        activityState({
          managedCommands: [
            shell({
              state: "exited",
              exitCode: 0,
              signal: null,
              exitedAtMs: 2,
            }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("reads null for a stopped or interrupted shell", () => {
    expect(
      chatActivityIndicator(
        activityState({
          managedCommands: [
            shell({ state: "stopped", stoppedAtMs: 2 }),
            shell({ state: "interrupted", interruptedAtMs: 3 }),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("prioritizes the turn when a shell runs alongside an active turn", () => {
    expect(
      chatActivityIndicator(
        activityState({
          runStatus: "running",
          activeTurn: ACTIVE_TURN,
          turnInProgress: true,
          managedCommands: [
            shell({ state: "running", pid: 4242, startedAtMs: 1 }),
          ],
        }),
      ),
    ).toBe("turn");
  });
});

describe("canModifyChatMessages", () => {
  const PENDING_USER_MESSAGE: PendingUserMessage = {
    clientActionId: "action-1",
    messageId: "message-1",
    content: CONTENT,
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" },
    deliveryPolicy: null,
    attachments: [],
    timestamp: 0,
    restore: { content: CONTENT, browserAnnotations: [] },
    restoreWorktreeIntent: null,
  };

  function gateState(
    overrides: Partial<Parameters<typeof canModifyChatMessages>[0]["state"]>,
  ): Parameters<typeof canModifyChatMessages>[0]["state"] {
    return {
      runStatus: "idle",
      activeTurn: null,
      queue: EMPTY_QUEUE,
      backgroundItems: undefined,
      turnInProgress: undefined,
      pendingUserMessages: [],
      pendingActions: {},
      ...overrides,
    };
  }

  it("allows edit/delete on a fully idle chat", () => {
    expect(canModifyChatMessages({ canAct: true, state: gateState({}) })).toBe(
      true,
    );
  });

  it("denies when the viewer cannot act", () => {
    expect(canModifyChatMessages({ canAct: false, state: gateState({}) })).toBe(
      false,
    );
  });

  it("denies while the host reports a turn genuinely in progress (pre-turn activating window included)", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({ runStatus: "running", turnInProgress: true }),
      }),
    ).toBe(false);
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({ runStatus: "stopping", turnInProgress: true }),
      }),
    ).toBe(false);
  });

  it("allows when runStatus is running purely because visible background work outlives the settled turn - the reported regression", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          runStatus: "running",
          turnInProgress: false,
          backgroundItems: [
            {
              taskId: "t1",
              kind: "command",
              title: "bun test",
              blockId: "t1",
              parentTaskId: null,
              scheduledFor: null,
              individualStopUnavailable: null,
            },
          ],
        }),
      }),
    ).toBe(true);
  });

  it("older-host fallback: background-only running phase opens the gate without turnInProgress", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          runStatus: "running",
          turnInProgress: undefined,
          backgroundItems: [
            {
              taskId: "t1",
              kind: "monitor",
              title: "Monitor",
              blockId: "t1",
              parentTaskId: null,
              scheduledFor: null,
            },
          ],
        }),
      }),
    ).toBe(true);
  });

  it("older-host fallback: an unexplained running status (activating window) keeps the gate closed", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({ runStatus: "running", turnInProgress: undefined }),
      }),
    ).toBe(false);
  });

  it("allows while queued items are parked with no turn in progress - they survive the rewrite and send against the new head", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          runStatus: "running",
          turnInProgress: false,
          queue: runnableQueue(1),
        }),
      }),
    ).toBe(true);
  });

  it("allows while the queue is paused after an errored turn", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          queue: { status: "paused", items: runnableQueue(1).items },
        }),
      }),
    ).toBe(true);
  });

  it("denies while an optimistic user message is still unconfirmed", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          pendingUserMessages: [PENDING_USER_MESSAGE],
        }),
      }),
    ).toBe(false);
  });
});

// ── Escape hatch: host-pending interviews with no answerable card ────────────

function interviewMessage(
  id: string,
  segments: ReadonlyArray<{
    readonly blockId: string;
    readonly status: InterviewSegment["status"];
  }>,
): ChatMessage {
  return {
    ...MESSAGE,
    id,
    role: "assistant",
    persistentMessageId: id,
    segments: segments.map((segment) => ({
      id: segment.blockId,
      kind: "interview",
      status: segment.status,
      toolName: "AskUserQuestion",
      title: null,
      description: null,
      questions: [],
      answers: [],
      draftAnswers: [],
      outcome: null,
      settlement: null,
      error: null,
      delivery: null,
      forkedWithoutAnswer: false,
    })),
  };
}

describe("findUnanswerableInterviews", () => {
  it("flags a host-pending block the transcript already settled", () => {
    // The phantom-interview shape: the harness errored the AskUserQuestion, the
    // block persisted as `errored`, but the pending wait was rehydrated from a
    // dangling `interview.requested`. No card renders, yet sends are rejected.
    const messages = [
      interviewMessage("m-1", [
        { blockId: "settled-block", status: "errored" },
      ]),
    ];

    expect(
      findUnanswerableInterviews(
        messages,
        [{ blockId: "settled-block", requestedAt: 10 }],
        null,
      ),
    ).toEqual([{ blockId: "settled-block", requestedAt: 10 }]);
  });

  it("flags a host-pending block that is absent from the transcript", () => {
    expect(
      findUnanswerableInterviews(
        [],
        [{ blockId: "ghost-block", requestedAt: 7 }],
        null,
      ),
    ).toEqual([{ blockId: "ghost-block", requestedAt: 7 }]);
  });

  it("leaves an answerable streaming block to the interview card", () => {
    const messages = [
      interviewMessage("m-1", [
        { blockId: "streaming-block", status: "streaming" },
      ]),
    ];
    const pending = [{ blockId: "streaming-block", requestedAt: 10 }];

    // The two derivations partition the host's pending set - a block routed to
    // the card must never also raise the escape hatch.
    expect(findUnanswerableInterviews(messages, pending, null)).toEqual([]);
    expect(
      findPendingInterview(messages, (id) => id === "streaming-block")?.blockId,
    ).toBe("streaming-block");
  });

  it("separates a stuck block from an answerable one in the same chat", () => {
    const messages = [
      interviewMessage("m-1", [
        { blockId: "settled-block", status: "errored" },
      ]),
      interviewMessage("m-2", [
        { blockId: "streaming-block", status: "streaming" },
      ]),
    ];

    expect(
      findUnanswerableInterviews(
        messages,
        [
          { blockId: "settled-block", requestedAt: 10 },
          { blockId: "streaming-block", requestedAt: 20 },
        ],
        null,
      ),
    ).toEqual([{ blockId: "settled-block", requestedAt: 10 }]);
  });

  it("orders stuck blocks oldest first", () => {
    expect(
      findUnanswerableInterviews(
        [],
        [
          { blockId: "newer-block", requestedAt: 20 },
          { blockId: "older-block", requestedAt: 10 },
        ],
        null,
      ).map((interview) => interview.blockId),
    ).toEqual(["older-block", "newer-block"]);
  });

  it("returns one stable empty reference so the composer memo cannot churn", () => {
    // `renderedMessages` changes on every streaming token; a fresh `[]` here
    // would re-identify the composer's props each token.
    const first = findUnanswerableInterviews([], [], null);
    const second = findUnanswerableInterviews(
      [
        interviewMessage("m-1", [
          { blockId: "streaming-block", status: "streaming" },
        ]),
      ],
      [{ blockId: "streaming-block", requestedAt: 10 }],
      null,
    );

    expect(first).toEqual([]);
    expect(second).toBe(first);
  });

  /**
   * The windowed line, where "not in `messages`" stopped being evidence.
   *
   * The three cases below are the three states the host's judgement can be in
   * for a pending id, and only ONE of them may reach the dismiss affordance.
   * The other two are a question the reader can still answer.
   */
  describe("on the windowed line", () => {
    it("does not offer to dismiss a question the host placed at an ordinal", () => {
      // The bug this fixes. The block is answerable and merely cold - its row
      // outside the retained window - so the rendered scan misses it, and
      // before the host's answer this offered to settle it as errored.
      expect(
        findUnanswerableInterviews(
          [],
          [{ blockId: "cold-block", requestedAt: 10 }],
          [{ blockId: "cold-block", ordinal: 7 }],
        ),
      ).toEqual([]);
    });

    it("offers to dismiss a question the host says no row renders", () => {
      // `ordinal: null` is a judgement, not an absence: the host walked the
      // whole transcript and found nothing that could ever draw a card. This
      // is the phantom-interview case, and suppressing the notice here would
      // leave the chat wedged with no way out.
      expect(
        findUnanswerableInterviews(
          [],
          [{ blockId: "stuck-block", requestedAt: 10 }],
          [{ blockId: "stuck-block", ordinal: null }],
        ),
      ).toEqual([{ blockId: "stuck-block", requestedAt: 10 }]);
    });

    it("does not offer to dismiss a question the host has not judged", () => {
      // An id that became pending AFTER the snapshot: `interviewRequested`
      // publishes it, and the block delta that would have rendered it was
      // dropped because its row is evicted. Absent from the judgement is
      // "unjudged", never "unrenderable" - the next snapshot decides.
      expect(
        findUnanswerableInterviews(
          [],
          [{ blockId: "fresh-block", requestedAt: 10 }],
          [{ blockId: "other-block", ordinal: null }],
        ),
      ).toEqual([]);
    });

    it("still keeps a rendered streaming block out of the notice", () => {
      // The rendered scan is not replaced by the judgement, it is narrowed by
      // it: a block this client can already draw needs no host opinion.
      const messages = [
        interviewMessage("m-1", [
          { blockId: "live-block", status: "streaming" },
        ]),
      ];

      expect(
        findUnanswerableInterviews(
          messages,
          [{ blockId: "live-block", requestedAt: 10 }],
          [{ blockId: "live-block", ordinal: null }],
        ),
      ).toEqual([]);
    });

    it("separates a cold question from a genuinely stuck one in the same chat", () => {
      expect(
        findUnanswerableInterviews(
          [],
          [
            { blockId: "stuck-block", requestedAt: 10 },
            { blockId: "cold-block", requestedAt: 20 },
          ],
          [
            { blockId: "stuck-block", ordinal: null },
            { blockId: "cold-block", ordinal: 3 },
          ],
        ),
      ).toEqual([{ blockId: "stuck-block", requestedAt: 10 }]);
    });
  });
});

/**
 * A minimal `ChatSessionRecord` - `ChatSessionState["chat"]` post
 * `chatRecordWithoutTranscript`, so it carries no `messages`/`events` fields.
 * `shouldGenerateChatTitleForSubmittedMessage` only reads `isTitleEditedByUser`
 * off it, but the fixture is typed through the real field so a widening back
 * to `Chat` would surface here too.
 */
function chatRecord(
  isTitleEditedByUser: boolean,
): NonNullable<ChatSessionState["chat"]> {
  return {
    id: "chat-1",
    parentId: null,
    userId: "owner-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1,
    updatedAt: 1,
    isTitleEditedByUser,
    settings: null,
    activeSessionChain: null,
    claudePendingWakes: [],
    archivedAt: null,
    pinnedUserProviderHandle: null,
    lastDeliveredRolesDigest: null,
  };
}

function persistedUserMessage(
  messageId: string,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp: 4,
    sessionAnchor: null,
  };
}

function pendingUserMessage(clientActionId: string): PendingUserMessage {
  const accountContext: AccountContext = { type: "PERSONAL" };
  return {
    clientActionId,
    messageId: `message-${clientActionId}`,
    content: CONTENT,
    attachments: [],
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    timestamp: 4,
    accountContext,
    deliveryPolicy: null,
    restore: { content: CONTENT, browserAnnotations: [] },
    restoreWorktreeIntent: null,
  };
}

/**
 * Off the windowed line there is no window and no derived payload, which is
 * what makes `state.messages` the whole transcript there.
 */
const LEGACY_LINE = {
  transcriptWindow: emptyTranscriptWindow(),
  transcriptDerived: null,
} as const;

/** A windowed session holding `rowCount` rows, with the skeleton described. */
function windowedLine(input: {
  readonly rowCount: number;
  readonly skeleton: readonly (RowSkeletonEntry | undefined)[];
  readonly skeletonComplete: boolean;
}): {
  readonly transcriptWindow: TranscriptWindow;
  readonly transcriptDerived: ChatTranscriptDerived;
} {
  return {
    transcriptWindow: {
      ...emptyTranscriptWindow(),
      epoch: 1,
      rowCount: input.rowCount,
      skeleton: input.skeleton,
      skeletonComplete: input.skeletonComplete,
    },
    transcriptDerived: {
      latestAssistantUsage: null,
      pinnedTodo: null,
      pinnedTaskTodoItems: [],
      latestForkableAssistantMessageId: null,
      restorableSetupInterruption: null,
      interviewAnswerability: [],
      latestAssistantAuthFailureTurnKey: null,
      setupCardWindows: [],
    },
  };
}

function skeletonEntry(
  rowId: string,
  role: RowSkeletonEntry["role"],
): RowSkeletonEntry {
  return { rowId, createdAt: 0, role, byteLength: 10, bodyDigest: "d0" };
}

describe("shouldGenerateChatTitleForSubmittedMessage", () => {
  it("generates a title for the first message on a fresh, unedited chat", () => {
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...LEGACY_LINE,
        content: CONTENT,
      }),
    ).toBe(true);
  });

  it("does not generate a title once the user has edited it themselves", () => {
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(true),
        messages: [],
        pendingUserMessages: [],
        ...LEGACY_LINE,
        content: CONTENT,
      }),
    ).toBe(false);
  });

  it("does not generate a title for an empty submission", () => {
    const empty: JsonContent = { type: "doc", content: [] };
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...LEGACY_LINE,
        content: empty,
      }),
    ).toBe(false);
  });

  it("does not generate a title while a send is already pending", () => {
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [pendingUserMessage("action-1")],
        ...LEGACY_LINE,
        content: CONTENT,
      }),
    ).toBe(false);
  });

  it("does not generate a title once the transcript already has a user message", () => {
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [persistedUserMessage("m1")],
        pendingUserMessages: [],
        ...LEGACY_LINE,
        content: CONTENT,
      }),
    ).toBe(false);
  });

  it("still reads a null chat (no snapshot yet) as not user-edited", () => {
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: null,
        messages: [],
        pendingUserMessages: [],
        ...LEGACY_LINE,
        content: CONTENT,
      }),
    ).toBe(true);
  });

  // ─── The windowed line, where `messages` stops being the transcript ──────

  it("does not re-title an established chat whose user rows are all unhydrated", () => {
    // The failure this fixes. `messages` is empty because nothing in the
    // window is hydrated - not because nobody has ever spoken. The skeleton
    // knows better.
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...windowedLine({
          rowCount: 2,
          skeleton: [
            skeletonEntry("row-0", "user"),
            skeletonEntry("row-1", "assistant"),
          ],
          skeletonComplete: true,
        }),
        content: CONTENT,
      }),
    ).toBe(false);
  });

  it("still titles a brand-new windowed chat, whose skeleton is empty AND incomplete", () => {
    // `rowCount === 0` has to be checked before completeness: no chunk is ever
    // sent for an empty transcript, so its skeleton never becomes `complete`
    // and this chat would otherwise read as unknown and never be titled.
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...windowedLine({
          rowCount: 0,
          skeleton: [],
          skeletonComplete: false,
        }),
        content: CONTENT,
      }),
    ).toBe(true);
  });

  it("holds off while the skeleton is still streaming and has shown no user row", () => {
    // `unknown`. Folded into "do not generate" because the two failures are
    // not symmetric - re-titling rewrites what the user has been reading.
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...windowedLine({
          rowCount: 4,
          skeleton: [undefined, skeletonEntry("row-1", "assistant")],
          skeletonComplete: false,
        }),
        content: CONTENT,
      }),
    ).toBe(false);
  });

  it("titles a chat whose complete skeleton holds only system rows", () => {
    // A setup card renders as `system` and is not a person speaking, so a
    // chat that has only ever shown one is still awaiting its first message.
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...windowedLine({
          rowCount: 1,
          skeleton: [skeletonEntry("row-0", "system")],
          skeletonComplete: true,
        }),
        content: CONTENT,
      }),
    ).toBe(true);
  });

  it("answers from a PARTIAL skeleton the moment one user row is delivered", () => {
    // Chunks add entries and never retract one, so a delivered `user` entry
    // is decisive however much of the skeleton is still outstanding.
    expect(
      shouldGenerateChatTitleForSubmittedMessage({
        chat: chatRecord(false),
        messages: [],
        pendingUserMessages: [],
        ...windowedLine({
          rowCount: 40,
          skeleton: [undefined, skeletonEntry("row-1", "user")],
          skeletonComplete: false,
        }),
        content: CONTENT,
      }),
    ).toBe(false);
  });
});

const USAGE_A: TokenUsage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
};

const USAGE_B: TokenUsage = {
  inputTokens: 400,
  outputTokens: 500,
  totalTokens: 900,
};

function assistantMessageWithUsage(
  messageId: string,
  usage: TokenUsage | null,
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "claude-sonnet-4",
      displayName: "Claude Sonnet 4",
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [],
    startedAt: 5,
    timestamp: 5,
    turnId: "turn-1",
    usage,
    reasoningEffort: null,
    serviceTier: null,
    envCredentialVar: null,
    imageResolutions: [],
  };
}

describe("selectContextUsage", () => {
  it("prefers the live turn's usage over both persisted sources", () => {
    expect(
      selectContextUsage({
        liveTurnUsage: USAGE_A,
        messages: [assistantMessageWithUsage("a-1", USAGE_B)],
        transcriptDerived: derivedWith(USAGE_B),
      }),
    ).toBe(USAGE_A);
  });

  it("scans backwards for the last usage-bearing assistant row off the windowed line", () => {
    expect(
      selectContextUsage({
        liveTurnUsage: null,
        messages: [
          assistantMessageWithUsage("a-1", USAGE_A),
          assistantMessageWithUsage("a-2", USAGE_B),
          // A later row that never reported usage must not blank the chip.
          assistantMessageWithUsage("a-3", null),
        ],
        transcriptDerived: null,
      }),
    ).toBe(USAGE_B);
  });

  it("reads the host's fold on the windowed line, where the scan would find nothing", () => {
    // The shape the chip is being fixed for: a chat long enough to be windowed
    // holds no hydrated assistant row at all, so the backwards scan returns
    // null and the chip reads blank. The host looked at the whole transcript.
    expect(
      selectContextUsage({
        liveTurnUsage: null,
        messages: [],
        transcriptDerived: derivedWith(USAGE_A),
      }),
    ).toBe(USAGE_A);
  });

  it("reports the host's null rather than falling back to a hydrated row", () => {
    // Not a `??` chain. `latestAssistantUsage: null` is an ANSWER - the chip's
    // empty form - so a hydrated row must not override the party that can see
    // the whole transcript. Kills the mutation that writes `?? scan(...)`.
    expect(
      selectContextUsage({
        liveTurnUsage: null,
        messages: [assistantMessageWithUsage("a-1", USAGE_B)],
        transcriptDerived: derivedWith(null),
      }),
    ).toBeNull();
  });
});

function derivedWith(
  latestAssistantUsage: TokenUsage | null,
): ChatTranscriptDerived {
  return {
    latestAssistantUsage,
    pinnedTodo: null,
    pinnedTaskTodoItems: [],
    latestForkableAssistantMessageId: null,
    restorableSetupInterruption: null,
    interviewAnswerability: [],
    latestAssistantAuthFailureTurnKey: null,
    setupCardWindows: [],
  };
}
