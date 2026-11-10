import { describe, expect, it } from "vitest";
import {
  chatSubscribeServerFrameSchema,
  chatSubscribeWindowedServerFrameSchema,
  chatSubscribeV142,
  chatSubscribeV143,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.43`: the snapshot and `turnStateChanged` carry the goal
 * the chat's provider thread holds. Absent means the host cannot say; null
 * means there is no goal. `1.42` and below bind both frames without the key.
 * `turnOrdinal` is host-computed and checked; the provider's own numbers are
 * passed through unchecked.
 */

const envelope = {
  hasBinaryPayload: false as const,
  epicId: "epic-1",
  chatId: "chat-1",
};

const goal = {
  objective: "Ship the migration",
  status: "active" as const,
  tokenBudget: 50_000,
  tokensUsed: 1200,
  timeUsedSeconds: 90,
  turnOrdinal: 2,
  updatedAt: 1_700_000_000_000,
};

const windowedSnapshot = {
  chat: {
    parentId: null,
    id: "chat-1",
    userId: "user-1",
    hostId: "host-1",
    title: "Chat",
    createdAt: 1000,
    updatedAt: 1000,
    isTitleEditedByUser: false,
  },
  access: { role: "owner", ownerUserId: "user-1", canAct: true },
  queue: { status: "idle", items: [] },
  runStatus: "idle",
  activeTurn: null,
  pendingApprovals: [],
  pendingInterviews: [],
  worktreeBinding: null,
  missingWorktreePaths: [],
  pendingFileEditApprovals: [],
  accumulatedFileChangeCount: 0,
  transcriptEpoch: 0,
  rowCount: 0,
  indexRevision: null,
  tail: { fromOrdinal: 0, messages: [], events: [] },
  derived: {
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

function snapshotFrame(extra: Record<string, unknown>) {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: { ...windowedSnapshot, ...extra },
  };
}

function turnStateFrame(extra: Record<string, unknown>) {
  return {
    kind: "turnStateChanged",
    ...envelope,
    runStatus: "running",
    activeTurn: null,
    ...extra,
  };
}

const carriers = [
  { name: "windowed snapshot", build: snapshotFrame },
  { name: "turnStateChanged", build: turnStateFrame },
] as const;

function goalOf(frame: unknown): unknown {
  if (typeof frame !== "object" || frame === null) {
    throw new Error("expected a frame object");
  }
  const body = "snapshot" in frame ? frame.snapshot : frame;
  if (typeof body !== "object" || body === null) {
    throw new Error("expected a frame body object");
  }
  return "goal" in body ? body.goal : "absent";
}

describe.each(carriers)("$name on chat.subscribe@1.43", ({ build }) => {
  it.each([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ])("keeps a %s goal", (status) => {
    const parsed = chatSubscribeV143.serverFrameSchema.parse(
      build({ goal: { ...goal, status } }),
    );
    expect(goalOf(parsed)).toEqual({ ...goal, status });
  });

  it("keeps a null goal as null", () => {
    expect(
      goalOf(chatSubscribeV143.serverFrameSchema.parse(build({ goal: null }))),
    ).toBeNull();
  });

  it("leaves an absent goal absent", () => {
    expect(goalOf(chatSubscribeV143.serverFrameSchema.parse(build({})))).toBe(
      "absent",
    );
  });

  it("refuses an unknown goal status", () => {
    expect(
      chatSubscribeV143.serverFrameSchema.safeParse(
        build({ goal: { ...goal, status: "abandoned" } }),
      ).success,
    ).toBe(false);
  });

  it.each([0, -1, 1.5])("refuses a turnOrdinal of %s", (turnOrdinal) => {
    expect(
      chatSubscribeV143.serverFrameSchema.safeParse(
        build({ goal: { ...goal, turnOrdinal } }),
      ).success,
    ).toBe(false);
  });

  it("keeps a null turnOrdinal", () => {
    const parsed = chatSubscribeV143.serverFrameSchema.parse(
      build({ goal: { ...goal, turnOrdinal: null } }),
    );
    expect(goalOf(parsed)).toEqual({ ...goal, turnOrdinal: null });
  });

  it("passes the provider's numbers through unchecked", () => {
    const providerGoal = {
      ...goal,
      tokenBudget: 0,
      tokensUsed: 12.5,
      timeUsedSeconds: -3,
    };
    const parsed = chatSubscribeV143.serverFrameSchema.parse(
      build({ goal: providerGoal }),
    );
    expect(goalOf(parsed)).toEqual(providerGoal);
  });
});

describe.each(carriers)("$name on chat.subscribe@1.42", ({ build }) => {
  it("parses a frame carrying a goal and strips the key", () => {
    const parsed = chatSubscribeV142.serverFrameSchema.parse(build({ goal }));
    expect(goalOf(parsed)).toBe("absent");
  });
});

describe("the live unions outside the open harness line", () => {
  it.each([
    {
      name: "windowed union's snapshot",
      schema: chatSubscribeWindowedServerFrameSchema,
      build: snapshotFrame,
    },
    {
      name: "windowed union's turnStateChanged",
      schema: chatSubscribeWindowedServerFrameSchema,
      build: turnStateFrame,
    },
    {
      name: "full-snapshot union's turnStateChanged",
      schema: chatSubscribeServerFrameSchema,
      build: turnStateFrame,
    },
  ])("keeps the goal on the $name", ({ schema, build }) => {
    expect(goalOf(schema.parse(build({ goal })))).toEqual(goal);
  });
});
