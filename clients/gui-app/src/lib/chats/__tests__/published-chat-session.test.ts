import { describe, expect, it } from "vitest";
import type { PresentedChat } from "@traycer/protocol/persistence/chat-sync/presentation";
import type {
  JsonObject,
  JsonValue,
} from "@traycer/protocol/persistence/chat-sync/json";
import {
  convertPublishedChat,
  convertReplicaChat,
} from "@/lib/chats/published-chat-session";

/**
 * The forward-compatibility guarantee, at the granularity it has to hold.
 *
 * The presentation layer preserves an unknown block IN PLACE inside an
 * otherwise ordinary message - that is the whole reason it hands readers `raw`
 * alongside `known`. An adapter that reparses the whole record and drops it on
 * any failure inverts that: a single future block type deletes the known text,
 * file changes and plan sitting beside it. The published copy then silently
 * shows less than the chat contains, which is the one failure the fidelity
 * rules exist to prevent.
 *
 * The fixture below is the shape a cold review reproduced through the real
 * publish -> assemble -> present path: an assistant message carrying
 * [text, file_change, plan, <future type>].
 */

function textBlock(blockId: string, text: string): JsonObject {
  return {
    blockId,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    type: "text",
    text,
    providerNotice: null,
  };
}

function futureBlock(blockId: string): JsonObject {
  return {
    blockId,
    status: "completed",
    timestamp: 1,
    parentBlockId: null,
    // A type outside this build's vocabulary - the case the whole passthrough
    // layer exists for.
    type: "holodeck",
    payload: { deck: 7 },
  };
}

/**
 * A `JsonObject`'s values are `JsonValue`, so `String(...)` on one would
 * happily render an object as "[object Object]" and the fixture would assert
 * against that placeholder. Every block below really does carry string ids, so
 * this states it by NARROWING instead of coercing - a fixture that stops
 * carrying one fails here, loudly, rather than silently downstream.
 */
function jsonString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`fixture block has no string '${field}'`);
  }
  return value;
}

function presentedChatWith(blocks: readonly JsonObject[]): PresentedChat {
  const raw = {
    role: "assistant",
    messageId: "m1",
    timestamp: 1,
    // Required, nullable-but-not-defaulted on the live schema.
    turnId: null,
    usage: null,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "a1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [...blocks],
  };
  // Built through the real `PresentedChat` type rather than cast into it, so a
  // change to the presentation contract breaks this fixture instead of letting
  // it drift into asserting a shape the pipeline no longer produces.
  return {
    messages: [
      {
        messageId: "m1",
        variant: "assistant",
        known: null,
        raw,
        timestamp: 1,
        blocks: blocks.map((block) => ({
          blockId: jsonString(block.blockId, "blockId"),
          variant: jsonString(block.type, "type"),
          known: null,
          raw: block,
          payloadRefs: [],
        })),
      },
    ],
    events: [],
    fidelity: {
      unknownMessages: 0,
      unknownBlocks: 0,
      unknownEvents: 0,
      missingPayloads: 0,
    },
    chatId: "56254cae",
    parentChatId: null,
    ownerUserId: "user-1",
    originHostId: "host-b",
    title: "Walkthrough",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 1,
    lifecycle: {
      state: "active",
      archivedAt: null,
      deletedAt: null,
      residual: {},
    },
    settings: null,
    throughRecordSeq: 1,
    capturedAt: 1,
    parentHeadSha256: null,
  };
}

describe("convertPublishedChat", () => {
  it("keeps a message's known blocks when one block is from the future", () => {
    // The regression. Before this, the whole assistant message - and with it
    // every known block - was deleted because one sibling was unrecognized.
    const converted = convertPublishedChat(
      presentedChatWith([
        textBlock("b1", "known text"),
        futureBlock("b2"),
        textBlock("b3", "more known text"),
      ]),
    );
    expect(converted.messages).toHaveLength(1);
    const message = converted.messages[0];
    expect(message.role).toBe("assistant");
    if (message.role !== "assistant") throw new Error("expected assistant");
    expect(message.blocks).toHaveLength(3);
    const texts = message.blocks.flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    );
    expect(texts).toContain("known text");
    expect(texts).toContain("more known text");
  });

  it("renders the unreadable block in place rather than omitting it", () => {
    // An omitted block is indistinguishable from a message that never had one,
    // and the composer's summary line cannot say WHERE the gap was.
    const converted = convertPublishedChat(
      presentedChatWith([textBlock("b1", "known text"), futureBlock("b2")]),
    );
    const message = converted.messages[0];
    if (message.role !== "assistant") throw new Error("expected assistant");
    const placeholder = message.blocks.filter(
      (block) =>
        block.type === "text" && /needs a newer version/.test(block.text),
    );
    expect(placeholder).toHaveLength(1);
  });

  it("counts each replaced block so the surface can say how many", () => {
    const converted = convertPublishedChat(
      presentedChatWith([
        textBlock("b1", "known text"),
        futureBlock("b2"),
        futureBlock("b3"),
      ]),
    );
    expect(converted.unreadableCount).toBe(2);
  });

  it("keeps a wholly ordinary message untouched", () => {
    const converted = convertPublishedChat(
      presentedChatWith([textBlock("b1", "known text")]),
    );
    expect(converted.unreadableCount).toBe(0);
    const message = converted.messages[0];
    if (message.role !== "assistant") throw new Error("expected assistant");
    expect(message.blocks).toHaveLength(1);
    expect(message.blocks[0].type).toBe("text");
  });
});

/**
 * `convertReplicaChat`'s rows are raw doc records, not the split
 * head/shard shape `PresentedChat` produces - a doc row's `blocks` sit
 * inline on the message itself, exactly as `readMessages()` reconstructs
 * them. The screening rule is the one `convertPublishedChat` uses, applied
 * to that inline array instead of a parallel presented list.
 */
function replicaAssistantRow(
  blocks: readonly JsonObject[],
): Record<string, unknown> {
  return {
    role: "assistant",
    messageId: "m1",
    timestamp: 1,
    turnId: null,
    usage: null,
    sender: {
      type: "agent",
      harnessId: "claude",
      agentId: "a1",
      displayName: null,
      reply: { expectsReply: false },
      inReplyTo: null,
    },
    blocks: [...blocks],
  };
}

describe("convertReplicaChat", () => {
  it("keeps a wholly ordinary doc row untouched", () => {
    const converted = convertReplicaChat(
      [replicaAssistantRow([textBlock("b1", "known text")])],
      [],
    );
    expect(converted.unreadableCount).toBe(0);
    expect(converted.messages).toHaveLength(1);
    const message = converted.messages[0];
    if (message.role !== "assistant") throw new Error("expected assistant");
    expect(message.blocks).toHaveLength(1);
    expect(message.blocks[0].type).toBe("text");
  });

  it("swaps an unknown block for a placeholder instead of dropping the whole row", () => {
    const converted = convertReplicaChat(
      [replicaAssistantRow([textBlock("b1", "known text"), futureBlock("b2")])],
      [],
    );
    expect(converted.messages).toHaveLength(1);
    const message = converted.messages[0];
    if (message.role !== "assistant") throw new Error("expected assistant");
    expect(message.blocks).toHaveLength(2);
    const placeholder = message.blocks.filter(
      (block) =>
        block.type === "text" && /needs a newer version/.test(block.text),
    );
    expect(placeholder).toHaveLength(1);
    expect(converted.unreadableCount).toBe(1);
  });

  it("drops and counts a row whose envelope cannot be represented at all", () => {
    // No `blocks` array to screen, so there is nothing to rebuild through -
    // this is the ENVELOPE failure, not a block failure.
    const converted = convertReplicaChat(
      [{ role: "from-the-future", messageId: "m2", timestamp: 1 }],
      [],
    );
    expect(converted.messages).toHaveLength(0);
    expect(converted.unreadableCount).toBe(1);
  });

  it("swaps null and non-object block entries for placeholders too, not just unrecognized objects", () => {
    // `null` and a bare number are the two shapes the block-id fallback in
    // `rebuildReplicaMessage` exists for - `typeof null === "object"` would
    // otherwise slip past a naive object check, and a number has no
    // `blockId` to read at all. Built as a plain row rather than through
    // `replicaAssistantRow` (typed to `readonly JsonObject[]`) since neither
    // shape here IS one.
    const row: Record<string, unknown> = {
      role: "assistant",
      messageId: "m1",
      timestamp: 1,
      turnId: null,
      usage: null,
      sender: {
        type: "agent",
        harnessId: "claude",
        agentId: "a1",
        displayName: null,
        reply: { expectsReply: false },
        inReplyTo: null,
      },
      blocks: [textBlock("b1", "known text"), null, 42],
    };
    const converted = convertReplicaChat([row], []);
    expect(converted.messages).toHaveLength(1);
    const message = converted.messages[0];
    if (message.role !== "assistant") throw new Error("expected assistant");
    expect(message.blocks).toHaveLength(3);
    const placeholders = message.blocks.filter(
      (block) =>
        block.type === "text" && /needs a newer version/.test(block.text),
    );
    expect(placeholders).toHaveLength(2);
    expect(converted.unreadableCount).toBe(2);
  });
});
