import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ExternalToast } from "sonner";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatActiveTurn,
  ChatQueueState,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
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
  showRestoreResultToast,
  type InlineEditState,
} from "../chat-tile-session-state";
import type { PendingUserMessage } from "@/stores/chats/chat-session-store";

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
  it("requires a dirty edit before enabling submit", () => {
    expect(renderInlineEdit(false).canSubmit).toBe(false);
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
      queueItemId: `item-${index}`,
      messageId: `message-${index}`,
      message: { kind: "user" as const, content: CONTENT },
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

  it("reads null for an idle chat", () => {
    expect(
      chatActivityIndicator({
        runStatus: "idle",
        activeTurn: null,
        queue: EMPTY_QUEUE,
        backgroundItems: [],
        turnInProgress: false,
      }),
    ).toBeNull();
  });

  it("reads turn while the host reports a genuine turn in progress", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: ACTIVE_TURN,
        queue: EMPTY_QUEUE,
        backgroundItems: [],
        turnInProgress: true,
      }),
    ).toBe("turn");
  });

  it("reads background when only a Monitor/background task keeps the chat non-idle", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: EMPTY_QUEUE,
        backgroundItems: [MONITOR_ITEM],
        turnInProgress: false,
      }),
    ).toBe("background");
  });

  it("reads turn (not background) while a detached subagent is still running", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: EMPTY_QUEUE,
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
        turnInProgress: false,
      }),
    ).toBe("turn");
  });

  it("reads turn (not background) while a detached workflow fleet is still running", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: EMPTY_QUEUE,
        backgroundItems: [
          MONITOR_ITEM,
          {
            taskId: "t3",
            kind: "workflow" as const,
            title: "review-changes",
            blockId: "t3",
            parentTaskId: null,
            phase: null,
            activeLabel: null,
            agentsStarted: null,
            agentsFinished: null,
          },
        ],
        turnInProgress: false,
      }),
    ).toBe("turn");
  });

  it("prioritizes the turn when a turn and background work run simultaneously", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: ACTIVE_TURN,
        queue: EMPTY_QUEUE,
        backgroundItems: [MONITOR_ITEM],
        turnInProgress: true,
      }),
    ).toBe("turn");
  });

  it("reads turn (not background) while a runnable queue drains between turns", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: runnableQueue(1),
        backgroundItems: [],
        turnInProgress: false,
      }),
    ).toBe("turn");
  });

  it("keeps the stopping phase on the turn tier", () => {
    expect(
      chatActivityIndicator({
        runStatus: "stopping",
        activeTurn: ACTIVE_TURN,
        queue: EMPTY_QUEUE,
        backgroundItems: [],
        turnInProgress: true,
      }),
    ).toBe("turn");
  });

  it("falls back to the older-host heuristic when turnInProgress is absent", () => {
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: EMPTY_QUEUE,
        backgroundItems: [MONITOR_ITEM],
        turnInProgress: undefined,
      }),
    ).toBe("background");
    expect(
      chatActivityIndicator({
        runStatus: "running",
        activeTurn: null,
        queue: EMPTY_QUEUE,
        backgroundItems: undefined,
        turnInProgress: undefined,
      }),
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
    timestamp: 0,
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

  it("denies while a queued item is pending, even with no turn in progress", () => {
    expect(
      canModifyChatMessages({
        canAct: true,
        state: gateState({
          runStatus: "running",
          turnInProgress: false,
          queue: runnableQueue(1),
        }),
      }),
    ).toBe(false);
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
      error: null,
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
      findUnanswerableInterviews(messages, [
        { blockId: "settled-block", requestedAt: 10 },
      ]),
    ).toEqual([{ blockId: "settled-block", requestedAt: 10 }]);
  });

  it("flags a host-pending block that is absent from the transcript", () => {
    expect(
      findUnanswerableInterviews(
        [],
        [{ blockId: "ghost-block", requestedAt: 7 }],
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
    expect(findUnanswerableInterviews(messages, pending)).toEqual([]);
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
      findUnanswerableInterviews(messages, [
        { blockId: "settled-block", requestedAt: 10 },
        { blockId: "streaming-block", requestedAt: 20 },
      ]),
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
      ).map((interview) => interview.blockId),
    ).toEqual(["older-block", "newer-block"]);
  });

  it("returns one stable empty reference so the composer memo cannot churn", () => {
    // `renderedMessages` changes on every streaming token; a fresh `[]` here
    // would re-identify the composer's props each token.
    const first = findUnanswerableInterviews([], []);
    const second = findUnanswerableInterviews(
      [
        interviewMessage("m-1", [
          { blockId: "streaming-block", status: "streaming" },
        ]),
      ],
      [{ blockId: "streaming-block", requestedAt: 10 }],
    );

    expect(first).toEqual([]);
    expect(second).toBe(first);
  });
});
