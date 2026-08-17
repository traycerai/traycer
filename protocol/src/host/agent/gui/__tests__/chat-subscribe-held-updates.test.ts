import {
  chatSubscribeServerFrameSchema,
  chatSubscribeV15,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import { describe, expect, it } from "vitest";

/**
 * The Stop fence's held updates on `chat.subscribe@1.6` - the snapshot's
 * `heldUpdates` and the `heldUpdatesChanged` frame that gives
 * `managedCommand.deliverHeld` something to act on (see `unary-schemas.ts`
 * and `contracts.ts`).
 *
 * These arrived on a `1.7` opened above a `1.6` that was hand-frozen to
 * `managedCommandSchemaPreImage`, so that a live addition could not leak onto
 * it. The release collapsed the two: neither minor had ever been negotiated -
 * no released baseline carries `chat.subscribe` above `1.5` - so the freeze
 * separating them protected no peer, and shipping both would have announced
 * two lines where one peer set exists.
 *
 * The regression this suite exists to catch therefore points one line lower,
 * at `1.5`, which is where the freeze starts protecting something real: it
 * shipped, it predates the whole Shells surface, and a `1.5` peer must never
 * observe `heldUpdates`/`heldUpdatesChanged`.
 *
 * Note what those tests do NOT cover: the host serializes frames as-is, so a
 * frozen schema only STRIPS on parse. Keeping the field off an older peer's
 * wire is the host's job, in `chat-frame-projection.ts`, and no schema test can
 * see a regression there.
 */

const chat: Chat = {
  parentId: null,
  id: "chat-1",
  userId: "user-1",
  hostId: "test-host",
  title: "Chat",
  createdAt: 1000,
  updatedAt: 1000,
  isTitleEditedByUser: false,
  settings: null,
  activeSessionChain: null,
  claudePendingWakes: [],
  messages: [
    {
      role: "user",
      messageId: "message-1",
      sender: { type: "user", userId: "user-1" },
      message: { kind: "user", content: { type: "doc", content: [] } },
      timestamp: 1000,
      sessionAnchor: null,
    },
  ],
  events: [],
  archivedAt: null,
  pinnedUserProviderHandle: null,
  lastDeliveredRolesDigest: null,
};

const HELD = {
  commandId: "cmd-1",
  description: "deploy watcher",
  heldAtMs: 1_700_000_000_000,
};

function snapshotFrameWithHeldUpdates(
  heldUpdates: ReadonlyArray<unknown> | undefined,
): Record<string, unknown> {
  return {
    kind: "snapshot",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    snapshot: {
      chat,
      access: { role: "owner", ownerUserId: "user-1", canAct: true },
      queue: { status: "idle", items: [] },
      activeTurn: null,
      runStatus: "idle",
      pendingApprovals: [],
      pendingInterviews: [],
      pendingFileEditApprovals: [],
      worktreeBinding: null,
      missingWorktreePaths: [],
      accumulatedFileChanges: [],
      managedCommands: [],
      ...(heldUpdates === undefined ? {} : { heldUpdates }),
    },
  };
}

const heldUpdatesChangedFrame = {
  kind: "heldUpdatesChanged",
  hasBinaryPayload: false,
  epicId: "epic-1",
  chatId: "chat-1",
  heldUpdates: [HELD],
};

describe("chat.subscribe@1.6 (held updates)", () => {
  it("carries the chat's held updates on a live snapshot", () => {
    const parsed = chatSubscribeServerFrameSchema.parse(
      snapshotFrameWithHeldUpdates([HELD]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.heldUpdates).toEqual([HELD]);
  });

  // `default([])`, not `optional()`: a consumer never null-checks it, on
  // either channel, the same discipline `managedCommands` uses.
  it("defaults an omitted snapshot heldUpdates to []", () => {
    const parsed = chatSubscribeServerFrameSchema.parse(
      snapshotFrameWithHeldUpdates(undefined),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot.heldUpdates).toEqual([]);
  });

  it("parses a heldUpdatesChanged frame carrying the whole set", () => {
    const parsed = chatSubscribeServerFrameSchema.parse(
      heldUpdatesChangedFrame,
    );
    if (parsed.kind !== "heldUpdatesChanged") {
      throw new Error("expected heldUpdatesChanged");
    }
    expect(parsed.heldUpdates).toEqual([HELD]);
  });

  it("defaults an omitted heldUpdatesChanged set to []", () => {
    const parsed = chatSubscribeServerFrameSchema.parse({
      kind: "heldUpdatesChanged",
      hasBinaryPayload: false,
      epicId: "epic-1",
      chatId: "chat-1",
    });
    if (parsed.kind !== "heldUpdatesChanged") {
      throw new Error("expected heldUpdatesChanged");
    }
    expect(parsed.heldUpdates).toEqual([]);
  });

  // THE regression guard, aimed at `1.5` - the newest line with peers in the
  // field. It is bound to hand-frozen schemas exactly so a live addition
  // cannot leak onto it, and nothing else catches a leak, since the live
  // serverFrame union happily accepts either shape.
  it("the frozen 1.5 line has no variant for heldUpdatesChanged and rejects it", () => {
    expect(
      chatSubscribeV15.serverFrameSchema.safeParse(heldUpdatesChangedFrame)
        .success,
    ).toBe(false);
  });

  it("a 1.5 snapshot carrying heldUpdates strips the field rather than growing", () => {
    const parsed = chatSubscribeV15.serverFrameSchema.parse(
      snapshotFrameWithHeldUpdates([HELD]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot).not.toHaveProperty("heldUpdates");
  });
});
