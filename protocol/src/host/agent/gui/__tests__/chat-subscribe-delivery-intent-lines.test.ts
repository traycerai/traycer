import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR,
  projectChatServerFrameForVersion,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";

/**
 * Every `chat.subscribe` line that has a delivery binds it through its own
 * schema, so `worktreeIntent` has to be absent on each line below `1.42` by
 * that schema, not only by the projection a host could skip. These parse a
 * complete snapshot on each line, because a schema only proves its freeze on a
 * frame it accepts. `chat-schema-checkpoints.test.ts` pins digests only through
 * `1.32`, which leaves `1.33` to `1.41` to this file.
 *
 * The lines come from the registry, so a line added later is covered without an
 * edit here. `chat-subscribe-delivery-intent-v142.test.ts` covers the rest of
 * the field's behaviour.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];

const FIRST_DELIVERY_MINOR = 15;
const DELIVERY_MINORS = Object.keys(line.versions)
  .map(Number)
  .filter((minor) => minor >= FIRST_DELIVERY_MINOR)
  .sort((a, b) => a - b);

const envelope = {
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
} as const;

const worktreeIntent = {
  entries: [
    {
      kind: "worktree",
      workspacePath: "/repo",
      repoIdentifier: null,
      isPrimary: true,
      branch: {
        type: "new",
        name: "polite-turtle",
        source: "main",
        carryUncommittedChanges: false,
        collision: "random",
        retryIdentity: "retry-1",
      },
      scripts: null,
    },
  ],
} as const;

const frozenDelivery = {
  messageId: "message-1",
  revision: 1,
  state: { phase: "pending" },
} as const;

const delivery = { ...frozenDelivery, worktreeIntent } as const;

const changedFrame = {
  kind: "messageDeliveryChanged",
  ...envelope,
  delivery,
} as const;

function snapshotFrame(messageDelivery: unknown) {
  return {
    kind: "snapshot",
    ...envelope,
    snapshot: {
      chat: {
        parentId: null,
        id: "chat-1",
        userId: "user-1",
        hostId: "host-1",
        title: "Chat",
        createdAt: 1000,
        updatedAt: 1000,
        isTitleEditedByUser: false,
        settings: {
          harnessId: "codex",
          model: "gpt-5.4",
          permissionMode: "supervised",
          reasoningEffort: "high",
          agentMode: "epic",
        },
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
      messageDelivery,
    },
  } as const;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected object for ${label}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function parseOnLine(minor: number, frame: unknown): Record<string, unknown> {
  const result =
    line.versions[minor].contract.serverFrameSchema.safeParse(frame);
  expect(result.success, `1.${minor} must parse the frame`).toBe(true);
  if (!result.success) throw new Error(`1.${minor} refused the frame`);
  return asRecord(result.data, "frame");
}

function snapshotDelivery(frame: Record<string, unknown>): unknown {
  return asRecord(frame.snapshot, "snapshot").messageDelivery;
}

function expectedDeliveryOn(minor: number): unknown {
  return minor >= CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR
    ? delivery
    : frozenDelivery;
}

function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

describe("the lines this file walks", () => {
  it("run from the first delivery line through the head, with the intent's line among them", () => {
    expect(DELIVERY_MINORS[0]).toBe(FIRST_DELIVERY_MINOR);
    expect(DELIVERY_MINORS.at(-1)).toBe(line.latestMinor);
    expect(DELIVERY_MINORS).toContain(CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR);
    expect(DELIVERY_MINORS).toContain(CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR - 1);
  });
});

describe.each(DELIVERY_MINORS)("chat.subscribe@1.%i", (minor) => {
  it("its own schema decides whether messageDeliveryChanged keeps the intent", () => {
    expect(parseOnLine(minor, changedFrame).delivery).toEqual(
      expectedDeliveryOn(minor),
    );
  });

  it("its own schema decides whether a complete snapshot keeps the intent", () => {
    expect(
      snapshotDelivery(parseOnLine(minor, snapshotFrame(delivery))),
    ).toEqual(expectedDeliveryOn(minor));
  });

  it("the projection sends messageDeliveryChanged in that line's shape, which the line then parses unchanged", () => {
    const projected = projectChatServerFrameForVersion(
      changedFrame,
      version(minor),
    );
    expect(projected.delivery).toEqual(expectedDeliveryOn(minor));
    expect(parseOnLine(minor, projected).delivery).toEqual(projected.delivery);
  });

  it("the projection sends the snapshot in that line's shape, which the line then parses unchanged", () => {
    const projected = projectChatServerFrameForVersion(
      snapshotFrame(delivery),
      version(minor),
    );
    expect(snapshotDelivery(asRecord(projected, "frame"))).toEqual(
      expectedDeliveryOn(minor),
    );
    expect(snapshotDelivery(parseOnLine(minor, projected))).toEqual(
      expectedDeliveryOn(minor),
    );
  });
});

describe("a peer whose version is not negotiated yet", () => {
  it("gets neither carrier's intent", () => {
    expect(
      projectChatServerFrameForVersion(changedFrame, null).delivery,
    ).toEqual(frozenDelivery);
    expect(
      snapshotDelivery(
        asRecord(
          projectChatServerFrameForVersion(snapshotFrame(delivery), null),
          "frame",
        ),
      ),
    ).toEqual(frozenDelivery);
  });
});

describe("a complete 1.42 snapshot", () => {
  const LIVE_MINOR = CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR;

  it("retains the intent alongside the rest of the snapshot", () => {
    const parsed = asRecord(
      parseOnLine(LIVE_MINOR, snapshotFrame(delivery)).snapshot,
      "snapshot",
    );
    expect(parsed.messageDelivery).toEqual(delivery);
    expect(parsed).toMatchObject({
      rowCount: 0,
      runStatus: "idle",
      chat: { id: "chat-1" },
      tail: { fromOrdinal: 0, messages: [] },
    });
  });

  it("reads a delivery with the key omitted, as a 1.41 host sends it, as carrying no intent", () => {
    expect(
      snapshotDelivery(parseOnLine(LIVE_MINOR, snapshotFrame(frozenDelivery))),
    ).toEqual({ ...frozenDelivery, worktreeIntent: null });
  });
});
