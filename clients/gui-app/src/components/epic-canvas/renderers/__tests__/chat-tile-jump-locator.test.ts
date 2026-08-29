import { describe, expect, it } from "vitest";
import type { RowSkeletonEntry } from "@traycer/protocol/persistence/chat-transcript/row-skeleton";
import {
  coldJumpOrdinal,
  hostLocatorForJumpTarget,
} from "@/components/epic-canvas/renderers/chat-tile-jump-logic";
import type { ChatMessage } from "@/stores/composer/chat-store";
import {
  emptyTranscriptWindow,
  type TranscriptWindow,
} from "@/stores/chats/transcript-window";

/**
 * Which cross-tile jump targets this client can place, and which it must ask
 * the host about.
 *
 * The case these exist for is a `message` target naming an ASSISTANT record.
 * Its rows are turn-keyed (`assistant:<turnKey>`), so the durable id is not a
 * row id and the skeleton read misses; the rendered model carries it as
 * `persistentMessageId`, which a COLD row does not have. Both client reads
 * therefore miss on exactly the rows a jump is most likely to land on in a long
 * chat, and without a host answer the jump parks until its TTL drops it.
 */

function skeletonEntry(rowId: string, ordinal: number): RowSkeletonEntry {
  return {
    rowId,
    createdAt: 1000 + ordinal,
    role: "user",
    byteLength: 64,
    bodyDigest: `d-${rowId}`,
  };
}

function windowNaming(rowIds: readonly string[]): TranscriptWindow {
  return {
    ...emptyTranscriptWindow(),
    epoch: 1,
    rowCount: rowIds.length,
    skeleton: rowIds.map((rowId, ordinal) => skeletonEntry(rowId, ordinal)),
    skeletonComplete: true,
    skeletonStreamCoveredThrough: rowIds.length,
  };
}

/** Only the two fields either resolver reads; the rest is inert scaffolding. */
function renderedRow(input: {
  readonly id: string;
  readonly persistentMessageId: string | null;
}): ChatMessage {
  return {
    id: input.id,
    role: "assistant",
    content: "",
    segments: [],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1,
    completedAt: null,
    stopped: null,
    persistentMessageId: input.persistentMessageId,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

describe("hostLocatorForJumpTarget: a `message` target", () => {
  it("asks the host for an assistant record whose turn-keyed rows are cold", () => {
    // The skeleton names the turn's rows, not the record - and nothing is
    // hydrated, so there is no `persistentMessageId` to match either.
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [],
    });

    expect(locator).toEqual({ kind: "message", messageId: "m-turn" });
  });

  it("does NOT ask for a cold USER row, whose row id is its message id", () => {
    // The common case. The skeleton alone places it, so a request here would be
    // a round trip whose answer `coldJumpOrdinal` never reads.
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-1" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [],
    });

    expect(locator).toBeNull();
  });

  it("does NOT ask once the assistant row is hydrated and carries the durable id", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: windowNaming(["m-1", "assistant:turn-1"]),
      messages: [
        renderedRow({ id: "assistant:turn-1", persistentMessageId: "m-turn" }),
      ],
    });

    expect(locator).toBeNull();
  });

  it("asks for nothing on the legacy line, which holds the whole transcript", () => {
    const locator = hostLocatorForJumpTarget({
      target: { kind: "message", messageId: "m-turn" },
      transcriptWindow: null,
      messages: [],
    });

    expect(locator).toBeNull();
  });
});

describe("coldJumpOrdinal: a `message` target", () => {
  const window = windowNaming(["m-1", "assistant:turn-1", "m-2"]);

  it("falls through to the host's answer when the skeleton does not name the id", () => {
    // Without the fallback this is `null` forever: the record is an assistant
    // one, so no skeleton entry will ever carry its id however long the jump
    // waits.
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-turn" }, 1),
    ).toBe(1);
  });

  it("prefers the skeleton, so a placed row does not wait on an RPC", () => {
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-2" }, 99),
    ).toBe(2);
  });

  it("stays null while neither the skeleton nor the host has an answer", () => {
    expect(
      coldJumpOrdinal(window, { kind: "message", messageId: "m-turn" }, null),
    ).toBeNull();
  });
});
