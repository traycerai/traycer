import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  messageSchema,
  type Message,
} from "@traycer/protocol/persistence/epic/messages";
import type { ChatSessionAnchor } from "@traycer/protocol/persistence/epic/senders";
import type { TranscriptRowContext } from "@traycer/protocol/persistence/chat-transcript/row-context";
import {
  projectTranscriptRows,
  turnKeysWithUnprovableProfileWalk,
} from "@traycer/protocol/persistence/chat-transcript/row-projection";

/**
 * `TranscriptRowContext.sessionAnchor` is carried for exactly one consumer -
 * the renderer's per-turn account label - so the projection may only carry an
 * anchor it can prove belongs to the turn.
 *
 * It cannot when a fallback hop re-dispatches one user message as a second
 * attempt: the host rewrites that user row's anchor to the REPLACEMENT's, and
 * the walk then hands the original attempt an account it never ran on. These
 * pin which turns the projection refuses to speak for, and - just as
 * importantly - which it still does.
 */

function textBlock(blockId: string, timestamp: number): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp,
    type: "text" as const,
    text: "hi",
    providerNotice: null,
  };
}

function claudeAnchor(
  profileId: string,
  labelSnapshot: string,
): ChatSessionAnchor {
  return {
    harnessId: "claude",
    hostId: "host-1",
    sessionId: `session-${profileId}`,
    sessionWorkspaceSnapshot: {
      workspaceKind: "session-snapshot",
      primaryWorkspace: "/repo",
      secondaryWorkspaces: [],
    },
    claudeMessageUuid: "claude-msg-1",
    turnTailUuid: null,
    createdAt: 1000,
    coveredUntilMessageId: null,
    profileId,
    labelSnapshot,
    accountUuid: null,
    accentColor: null,
  };
}

function userMessage(fields: {
  messageId: string;
  timestamp: number;
  sessionAnchor: ChatSessionAnchor | null;
}): Message {
  return messageSchema.parse({
    role: "user",
    messageId: fields.messageId,
    sender: { type: "user", userId: "u-1" },
    message: { kind: "user", content: { type: "doc" } },
    timestamp: fields.timestamp,
    sessionAnchor: fields.sessionAnchor,
  });
}

/**
 * An autonomous-resume divider as PERSISTED. `deliveryPlacement: null` is the
 * historical shape - the schema defaults to it and documents it as
 * "historical/unknown" - so it is the default here too: every wake row written
 * before the field existed reads this way, and those are the rows the
 * autonomous exclusion has to recognise.
 */
function autonomousResumeBlock(
  blockId: string,
  timestamp: number,
  deliveryPlacement: "turn_start" | "in_turn" | null,
): unknown {
  return {
    blockId,
    status: "completed",
    timestamp,
    type: "autonomous_resume",
    deliveryPlacement,
    triggers: [],
    wakeTriggers: [],
  };
}

interface TurnProfileFixture {
  readonly profileId: string | null;
  readonly labelSnapshot: string | null;
}

function assistantMessage(fields: {
  messageId: string;
  turnId: string;
  timestamp: number;
  /** `null` means the record carries NO snapshot - see the spread below. */
  turnProfile: TurnProfileFixture | null;
  /** Prepended before the text block, making this an autonomous turn. */
  opensWith?: unknown;
}): Message {
  return messageSchema.parse({
    role: "assistant",
    messageId: fields.messageId,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "agent-1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [
      ...(fields.opensWith === undefined ? [] : [fields.opensWith]),
      textBlock(`b-${fields.messageId}`, fields.timestamp),
    ],
    startedAt: fields.timestamp,
    timestamp: fields.timestamp,
    turnId: fields.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
    // ABSENT, not null: the schema has no null state for this field, so a
    // fixture able to spell one would exercise a shape no host can write.
    ...(fields.turnProfile === null ? {} : { turnProfile: fields.turnProfile }),
  });
}

describe("turnKeysWithUnprovableProfileWalk", () => {
  it("refuses BOTH turns when two attempts share one user row and neither recorded its account", () => {
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 3000,
        turnProfile: null,
      }),
    ]);

    // Both, not just the later one: the mislabelled attempt is the FIRST, whose
    // anchor was rewritten out from under it.
    expect([...keys].sort()).toEqual(["turn-1", "turn-2"]);
  });

  it("says nothing about a user row with a single turn, which is most of every transcript", () => {
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      userMessage({
        messageId: "u-2",
        timestamp: 4000,
        sessionAnchor: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 5000,
        turnProfile: null,
      }),
    ]);

    expect(keys.size).toBe(0);
  });

  it("exempts a turn whose snapshot arrives on a record read AFTER the sibling that marked the span", () => {
    // The ordering the exemption pass exists for. `turn-1` is marked unprovable
    // while walking `turn-2`'s record, and only its own SECOND record carries
    // the snapshot - so an exemption applied inline during the walk would miss
    // it and refuse a turn that states its own account.
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 3000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-1b",
        turnId: "turn-1",
        timestamp: 4000,
        turnProfile: {
          profileId: "personal",
          labelSnapshot: "Claude Personal",
        },
      }),
    ]);

    expect([...keys]).toEqual(["turn-2"]);
  });

  it("does not count a steer-split turn twice", () => {
    // Two records sharing one `turnId`, with the steered user record between
    // them. That user record resets the span, and the dedupe keeps the turn
    // from re-entering it - otherwise every steered turn in the product would
    // lose its account label, which has nothing to do with fallback.
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      userMessage({
        messageId: "u-steer",
        timestamp: 2500,
        sessionAnchor: null,
      }),
      assistantMessage({
        messageId: "a-1b",
        turnId: "turn-1",
        timestamp: 2600,
        turnProfile: null,
      }),
    ]);

    expect(keys.size).toBe(0);
  });
});

describe("an autonomous turn is not a second ATTEMPT on the user row above it", () => {
  it("leaves the ordinary turn provable and refuses only the autonomous one", () => {
    // The regression the exclusion exists to prevent. A wake turn is started by
    // the host with no user message of its own, so its records land in the
    // preceding user row's span. Counting it as an attempt blanks the ORDINARY
    // turn's account label - on most historical agent chats, none of which ever
    // fell back.
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-ordinary",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-autonomous",
        timestamp: 3000,
        turnProfile: null,
        opensWith: autonomousResumeBlock("wake-1", 3000, null),
      }),
    ]);

    // The autonomous turn is still refused in its own right: no anchor is ever
    // minted for it (an anchor naming no user row is dropped), so the anchor in
    // effect belongs to someone else's turn and may name another account.
    expect([...keys]).toEqual(["turn-autonomous"]);
  });

  it("still refuses everything once there are two REAL attempts beside a wake", () => {
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-original",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-replacement",
        timestamp: 3000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-3",
        turnId: "turn-autonomous",
        timestamp: 4000,
        turnProfile: null,
        opensWith: autonomousResumeBlock("wake-1", 4000, null),
      }),
    ]);

    // The exclusion must not become an escape hatch: skipping the wake turn
    // leaves the two real attempts still sharing the row, and all three refuse.
    expect([...keys].sort()).toEqual([
      "turn-autonomous",
      "turn-original",
      "turn-replacement",
    ]);
  });

  it("reads an explicit turn_start divider the same way as a historical one", () => {
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-ordinary",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-autonomous",
        timestamp: 3000,
        turnProfile: null,
        opensWith: autonomousResumeBlock("wake-1", 3000, "turn_start"),
      }),
    ]);

    expect([...keys]).toEqual(["turn-autonomous"]);
  });

  it("an in_turn notification does NOT make its host turn autonomous", () => {
    // `in_turn` is appended into an already-running ORDINARY turn. It is
    // normally not the first block, but it can be when nothing had streamed
    // yet - and a modern record says so on itself, which is the half of the
    // discriminator that position alone cannot supply. Without this arm the
    // ordinary turn stops counting as an attempt and its sibling gets walked.
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-original",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-replacement",
        timestamp: 3000,
        turnProfile: null,
        opensWith: autonomousResumeBlock("notice-1", 3000, "in_turn"),
      }),
    ]);

    expect([...keys].sort()).toEqual(["turn-original", "turn-replacement"]);
  });

  it("a wake turn that recorded its own account is labelled from it, not refused", () => {
    const keys = turnKeysWithUnprovableProfileWalk([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-autonomous",
        timestamp: 2000,
        turnProfile: { profileId: "work", labelSnapshot: "Claude Work" },
        opensWith: autonomousResumeBlock("wake-1", 2000, null),
      }),
    ]);

    expect(keys.size).toBe(0);
  });
});

describe("projectTranscriptRows withholds the anchor it cannot prove", () => {
  function contextByTurnKey(
    messages: readonly Message[],
  ): ReadonlyMap<string, TranscriptRowContext> {
    const rows = projectTranscriptRows({
      messages,
      events: [],
      activeTurnId: null,
      chatId: "chat-1",
    });
    const out = new Map<string, TranscriptRowContext>();
    for (const row of rows) {
      if (row.source.kind !== "assistant-slice") continue;
      out.set(row.source.turnKey, row.context);
    }
    return out;
  }

  function anchorsByTurnKey(
    messages: readonly Message[],
  ): ReadonlyMap<string, string | null> {
    const out = new Map<string, string | null>();
    for (const [turnKey, context] of contextByTurnKey(messages)) {
      out.set(turnKey, context.sessionAnchor?.profileId ?? null);
    }
    return out;
  }

  it("carries the walked anchor for a single-attempt user row", () => {
    const carried = anchorsByTurnKey([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("personal", "Claude Personal"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
    ]);

    // The control for the refusal below: without this, "no anchor" in the
    // two-attempt case could also be a fixture that never carried one.
    expect(carried.get("turn-1")).toBe("personal");
  });

  it("carries NO anchor for either attempt once a user row has two", () => {
    const carried = anchorsByTurnKey([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 3000,
        turnProfile: null,
      }),
    ]);

    expect(carried.get("turn-1")).toBeNull();
    expect(carried.get("turn-2")).toBeNull();
  });

  it("states the refusal POSITIVELY, so it is not an empty context that never ships", () => {
    const contexts = contextByTurnKey([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: null,
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 3000,
        turnProfile: null,
      }),
    ]);

    for (const turnKey of ["turn-1", "turn-2"]) {
      const context = contexts.get(turnKey);
      expect(context?.profileWalkUnprovable).toBe(true);
      // The load-bearing half, and the reason the flag exists at all rather
      // than the withheld anchor carrying the message on its own: `read-range`
      // charges and emits a row's context only when
      // `Object.keys(context).length > 0`. These turns have nothing else to
      // say - a modern `startedAt`, no overlapping checkpoint - so without the
      // flag the object is empty, the refusal is never serialized, and a
      // windowed client sees silence and falls back to the walk being refused.
      expect(Object.keys(context ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("keeps carrying the anchor for a turn that recorded its own account", () => {
    // The snapshot outranks the walk in the renderer, so withholding here would
    // be churn with no behavioural payoff - and it would re-fingerprint every
    // modern row. The exemption keeps that cost off chats the rule is not about.
    const carried = anchorsByTurnKey([
      userMessage({
        messageId: "u-1",
        timestamp: 1000,
        sessionAnchor: claudeAnchor("work", "Claude Work"),
      }),
      assistantMessage({
        messageId: "a-1",
        turnId: "turn-1",
        timestamp: 2000,
        turnProfile: {
          profileId: "personal",
          labelSnapshot: "Claude Personal",
        },
      }),
      assistantMessage({
        messageId: "a-2",
        turnId: "turn-2",
        timestamp: 3000,
        turnProfile: { profileId: "work", labelSnapshot: "Claude Work" },
      }),
    ]);

    expect(carried.get("turn-1")).toBe("work");
    expect(carried.get("turn-2")).toBe("work");
  });
});
