import {
  chatSubscribeServerFrameSchema,
  chatSubscribeV16,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { Chat } from "@traycer/protocol/persistence/epic/schemas";
import { describe, expect, it } from "vitest";

/**
 * The Stop fence's held updates on `chat.subscribe@1.7` - the snapshot's
 * `heldUpdates` and the `heldUpdatesChanged` frame that gives
 * `managedCommand.deliverHeld` something to act on (see `unary-schemas.ts`
 * and `contracts.ts`).
 *
 * The regression this suite exists to catch: `chat.subscribe@1.6` is the line
 * the whole Shells surface arrived on, hand-frozen to
 * `managedCommandSchemaPreImage` precisely so a LIVE addition can never leak
 * onto it. `heldUpdates`/`heldUpdatesChanged` are `1.7`-only - a `1.6` peer
 * must never observe either.
 *
 * `1.6` has NOT shipped - no released baseline carries `chat.subscribe` above
 * `1.5` - so this guards the freeze DISCIPLINE rather than a peer in the field.
 * That is the point: the discipline is what will still be correct once `1.7`
 * ships and `1.6` becomes a line someone really negotiates.
 *
 * Note what these two tests do NOT cover: the host serializes frames as-is, so
 * a frozen schema only STRIPS on parse. Keeping the field off an older peer's
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

describe("chat.subscribe@1.7 (held updates)", () => {
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

  // THE regression guard: `1.6` is bound to hand-frozen pre-image schemas
  // exactly so a live addition cannot leak onto it - and nothing else catches
  // a leak, since the live serverFrame union happily accepts either shape.
  it("the frozen 1.6 line has no variant for heldUpdatesChanged and rejects it", () => {
    expect(
      chatSubscribeV16.serverFrameSchema.safeParse(heldUpdatesChangedFrame)
        .success,
    ).toBe(false);
  });

  it("a 1.6 snapshot carrying heldUpdates strips the field rather than growing", () => {
    const parsed = chatSubscribeV16.serverFrameSchema.parse(
      snapshotFrameWithHeldUpdates([HELD]),
    );
    if (parsed.kind !== "snapshot") throw new Error("expected snapshot");
    expect(parsed.snapshot).not.toHaveProperty("heldUpdates");
  });
});
