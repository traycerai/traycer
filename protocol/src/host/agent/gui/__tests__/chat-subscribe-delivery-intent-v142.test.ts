import { describe, expect, it } from "vitest";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/index";
import {
  chatSubscribeServerFrameSchema,
  chatSubscribeV141,
  chatSubscribeV142,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  CHAT_SUBSCRIBE_DELIVERY_INTENT_MINOR,
  projectChatServerFrameForVersion,
} from "@traycer/protocol/host/agent/gui/chat-frame-compat";
import { chatMessageDeliverySchema } from "@traycer/protocol/host/agent/gui/message-delivery";

/**
 * `chat.subscribe@1.42`: the delivery carries the opening's `worktreeIntent`,
 * on the snapshot's `messageDelivery` and on `messageDeliveryChanged.delivery`.
 *
 * `1.41` and below keep neither: the host strips the key for them, and the
 * frozen delivery schema has no field for it. A `1.41` host omits it, which a
 * `1.42` client reads as null.
 */

const line = hostStreamRpcRegistry["chat.subscribe"][1];
const V141 = { major: 1, minor: 41 } as const;
const V142 = { major: 1, minor: 42 } as const;

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
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  delivery,
} as const;

function snapshotFrame(messageDelivery: unknown) {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: { rowCount: 3, messageDelivery },
  } as const;
}

describe("chat.subscribe@1.42 registration", () => {
  it("binds 1.42 to its own contract, above a 1.41 that stays bound to its own frames", () => {
    expect(line.versions[42].contract).toBe(chatSubscribeV142);
    expect(line.versions[41].contract).toBe(chatSubscribeV141);
    expect(chatSubscribeV142.serverFrameSchema).not.toBe(
      chatSubscribeV141.serverFrameSchema,
    );
  });

  it("adds nothing to the request or the client frames", () => {
    expect(chatSubscribeV142.openRequestSchema).toBe(
      chatSubscribeV141.openRequestSchema,
    );
    expect(chatSubscribeV142.clientFrameSchema).toBe(
      chatSubscribeV141.clientFrameSchema,
    );
  });
});

describe("messageDeliveryChanged", () => {
  it("1.42 reads a 1.41 host's delivery as carrying no intent", () => {
    expect(
      chatSubscribeV142.serverFrameSchema.parse({
        ...changedFrame,
        delivery: frozenDelivery,
      }),
    ).toEqual({
      ...changedFrame,
      delivery: { ...frozenDelivery, worktreeIntent: null },
    });
  });

  it("1.42 still takes a retired delivery", () => {
    expect(
      chatSubscribeV142.serverFrameSchema.parse({
        ...changedFrame,
        delivery: null,
      }),
    ).toMatchObject({ delivery: null });
  });

  it("1.42 refuses a malformed intent", () => {
    expect(
      chatSubscribeV142.serverFrameSchema.safeParse({
        ...changedFrame,
        delivery: { ...frozenDelivery, worktreeIntent: { entries: "nope" } },
      }).success,
    ).toBe(false);
  });

  it("the live full-snapshot union keeps it too", () => {
    expect(chatSubscribeServerFrameSchema.parse(changedFrame)).toEqual(
      changedFrame,
    );
  });
});

describe("the frozen delivery schema", () => {
  it("still has no worktreeIntent", () => {
    expect(chatMessageDeliverySchema.parse(delivery)).toEqual(frozenDelivery);
  });
});

describe("projectChatServerFrameForVersion", () => {
  it("is the identity on 1.42 for both carriers", () => {
    const snapshot = snapshotFrame(delivery);
    expect(projectChatServerFrameForVersion(changedFrame, V142)).toBe(
      changedFrame,
    );
    expect(projectChatServerFrameForVersion(snapshot, V142).snapshot).toEqual(
      snapshot.snapshot,
    );
  });

  it("strips the snapshot's messageDelivery below 1.42, leaving the rest of it", () => {
    expect(
      projectChatServerFrameForVersion(snapshotFrame(delivery), V141).snapshot,
    ).toEqual({ rowCount: 3, messageDelivery: frozenDelivery });
  });

  it("leaves a retired delivery and a snapshot without one alone", () => {
    const retired = { ...changedFrame, delivery: null };
    expect(projectChatServerFrameForVersion(retired, V141)).toBe(retired);
    const absent = {
      kind: "snapshot",
      hasBinaryPayload: false,
      snapshot: { rowCount: 3 },
    } as const;
    expect(projectChatServerFrameForVersion(absent, V141).snapshot).toEqual(
      absent.snapshot,
    );
    expect(
      projectChatServerFrameForVersion(absent, V141).snapshot,
    ).not.toHaveProperty("messageDelivery");
  });
});
