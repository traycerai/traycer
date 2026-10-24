import { describe, expect, it } from "vitest";
import {
  backgroundItemSchema,
  chatSubscribeV120,
  chatSubscribeV121,
  chatSubscribeV122,
  chatSubscribeV123,
  chatSubscribeV124,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.24`: `scheduledFor` on a `cron` background item.
 *
 * The key is nullable and defaulted on the live line, so an older host's
 * schedule-only row still parses. Every frame `1.20` through `1.23` binds a
 * frozen cron shape: it never declares the key, so a frame that carries one
 * parses there with the key gone and everything else intact.
 */

const NEXT_RUN = 1_900_000_000_000;

const CRON_ITEM = {
  taskId: "cron-1",
  title: "Every 5 minutes",
  blockId: "block-cron-1",
  parentTaskId: null,
  kind: "cron",
  schedule: "*/5 * * * *",
  humanSchedule: "Every 5 minutes",
  prompt: "check the deploy",
  recurring: true,
} as const;

function windowedSnapshot(
  backgroundItems: readonly unknown[],
): Record<string, unknown> {
  return {
    chat: {
      parentId: null,
      userId: "owner-1",
      id: "chat-1",
      hostId: "host-1",
      title: "Chat",
      createdAt: 1_000,
      updatedAt: 1_000,
      isTitleEditedByUser: false,
    },
    access: { role: "owner", ownerUserId: "owner-1", canAct: true },
    queue: { status: "idle", items: [] },
    runStatus: "idle",
    activeTurn: null,
    pendingApprovals: [],
    pendingInterviews: [],
    worktreeBinding: null,
    missingWorktreePaths: [],
    pendingFileEditApprovals: [],
    accumulatedFileChangeCount: 0,
    managedCommands: [],
    heldUpdates: [],
    portForwards: [],
    transcriptEpoch: 0,
    rowCount: 0,
    indexRevision: null,
    tail: { fromOrdinal: 0, rowIds: [], messages: [], events: [] },
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
    backgroundItems,
  };
}

function snapshotFrame(backgroundItems: readonly unknown[]): unknown {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: windowedSnapshot(backgroundItems),
  };
}

function turnStateFrame(backgroundItems: readonly unknown[]): unknown {
  return {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    runStatus: "running",
    activeTurn: null,
    backgroundItems,
  };
}

function has(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function onlyCron(items: readonly object[] | undefined): object {
  const cron = items?.find((item) => "kind" in item && item.kind === "cron");
  if (cron === undefined) throw new Error("expected a cron item");
  return cron;
}

describe("the cron background item's scheduledFor (1.24)", () => {
  it("defaults to null when the key is absent", () => {
    expect(backgroundItemSchema.parse(CRON_ITEM)).toMatchObject({
      kind: "cron",
      scheduledFor: null,
    });
  });

  it("keeps a number and an explicit null", () => {
    expect(
      backgroundItemSchema.parse({ ...CRON_ITEM, scheduledFor: NEXT_RUN }),
    ).toMatchObject({ scheduledFor: NEXT_RUN });
    expect(
      backgroundItemSchema.parse({ ...CRON_ITEM, scheduledFor: null }),
    ).toMatchObject({ scheduledFor: null });
  });

  it("rejects a non-number time", () => {
    expect(
      backgroundItemSchema.safeParse({ ...CRON_ITEM, scheduledFor: "soon" })
        .success,
    ).toBe(false);
  });
});

describe("chat.subscribe@1.24 (live)", () => {
  const live = chatSubscribeV124.serverFrameSchema;

  it("has minor 24", () => {
    expect(chatSubscribeV124.schemaVersion).toEqual({ major: 1, minor: 24 });
  });

  it("snapshot: defaults an absent key to null and keeps a number", () => {
    const parsed = live.parse(
      snapshotFrame([
        CRON_ITEM,
        { ...CRON_ITEM, taskId: "cron-2", scheduledFor: NEXT_RUN },
      ]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const crons = parsed.snapshot.backgroundItems?.filter(
      (item) => item.kind === "cron",
    );
    expect(crons?.map((item) => item.scheduledFor)).toEqual([null, NEXT_RUN]);
  });

  it("turnStateChanged: defaults an absent key to null and keeps a number", () => {
    const parsed = live.parse(
      turnStateFrame([
        CRON_ITEM,
        { ...CRON_ITEM, taskId: "cron-2", scheduledFor: NEXT_RUN },
      ]),
    );
    if (parsed.kind !== "turnStateChanged") throw new Error("wrong kind");
    const crons = parsed.backgroundItems?.filter(
      (item) => item.kind === "cron",
    );
    expect(crons?.map((item) => item.scheduledFor)).toEqual([null, NEXT_RUN]);
  });
});

// `1.20` through `1.23` are frozen: the cron item is today's shape, with no
// next-run key, on all three frames that carry background items.
describe.each([
  { label: "1.20", frozen: chatSubscribeV120.serverFrameSchema },
  { label: "1.21", frozen: chatSubscribeV121.serverFrameSchema },
  { label: "1.22", frozen: chatSubscribeV122.serverFrameSchema },
  { label: "1.23", frozen: chatSubscribeV123.serverFrameSchema },
])("chat.subscribe@$label (frozen) carries no next-run key", ({ frozen }) => {
  it("snapshot: strips scheduledFor and keeps the rest of the cron item", () => {
    const parsed = frozen.parse(
      snapshotFrame([{ ...CRON_ITEM, scheduledFor: NEXT_RUN }]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    const cron = onlyCron(parsed.snapshot.backgroundItems);
    expect(has(cron, "scheduledFor")).toBe(false);
    expect(cron).toMatchObject({
      kind: "cron",
      schedule: "*/5 * * * *",
      humanSchedule: "Every 5 minutes",
      prompt: "check the deploy",
      recurring: true,
    });
  });

  it("snapshot: a cron item without the key does not gain one", () => {
    const parsed = frozen.parse(snapshotFrame([CRON_ITEM]));
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(has(onlyCron(parsed.snapshot.backgroundItems), "scheduledFor")).toBe(
      false,
    );
  });

  it("turnStateChanged: strips scheduledFor and keeps the rest of the cron item", () => {
    const parsed = frozen.parse(
      turnStateFrame([{ ...CRON_ITEM, scheduledFor: NEXT_RUN }]),
    );
    if (parsed.kind !== "turnStateChanged") throw new Error("wrong kind");
    const cron = onlyCron(parsed.backgroundItems);
    expect(has(cron, "scheduledFor")).toBe(false);
    expect(cron).toMatchObject({ kind: "cron", taskId: "cron-1" });
  });

  it("turnStateChanged: a cron item without the key does not gain one", () => {
    const parsed = frozen.parse(turnStateFrame([CRON_ITEM]));
    if (parsed.kind !== "turnStateChanged") throw new Error("wrong kind");
    expect(has(onlyCron(parsed.backgroundItems), "scheduledFor")).toBe(false);
  });
});
