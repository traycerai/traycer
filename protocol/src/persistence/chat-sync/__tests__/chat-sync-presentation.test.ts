import {
  assembleChat,
  type AssembledChat,
} from "@traycer/protocol/persistence/chat-sync/assembly";
import { CHAT_SYNC_READER_VERSION } from "@traycer/protocol/persistence/chat-sync/head";
import { canonicalizeJsonValue } from "@traycer/protocol/persistence/chat-sync/json";
import {
  NO_PAYLOADS_RESOLVABLE,
  describeMissingPayload,
  describeUnknownVariant,
  presentChat,
  type ChatPayloadResolver,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import { beforeAll, describe, expect, it } from "vitest";
import {
  publishChat,
  unknownBlock,
  unknownEvent,
  unknownMessage,
} from "./__fixtures__/published-chat";

/**
 * What a reader SHOWS for a chat it only partly understands.
 *
 * The failure this suite exists to prevent is the quiet one: an unknown block
 * silently dropped, or a file_change card rendered with no diff because its
 * blobs live on another machine. Both look like a working renderer and both
 * misrepresent the chat, so every unreadable thing has to arrive at the UI
 * flagged rather than absent.
 *
 * Driven from a real ASSEMBLY rather than a hand-built value, so the presenter
 * and the reader cannot drift into agreeing about a chat neither could produce.
 */

const everythingResolvable: ChatPayloadResolver = () => "resolvable";

let chat: AssembledChat;

beforeAll(async () => {
  const published = publishChat({
    graduate: { events: true, hostPrivate: true },
    parentHeadSha256: "f".repeat(64),
  });
  const result = await assembleChat({
    head: published.head,
    readerSupports: CHAT_SYNC_READER_VERSION,
    fetch: published.fetch,
  });
  if (result.status !== "ok") throw new Error("expected an assembled chat");
  chat = result.chat;
});

describe("presentChat", () => {
  it("keeps unknown variants in place rather than dropping them", () => {
    const presented = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    });

    // Position matters: a dropped unknown message would silently reorder the
    // transcript around it.
    expect(presented.messages.map((message) => message.variant)).toEqual([
      "user",
      "assistant",
      "telemetry",
    ]);
    expect(presented.events.map((event) => event.variant)).toEqual([
      "turn.started",
      "warp.engaged",
    ]);

    const unknown = presented.messages[2];
    expect(unknown.known).toBeNull();
    expect(unknown.messageId).toBe("m-future");
    expect(unknown.raw).toEqual(canonicalizeJsonValue(unknownMessage));
  });

  it("reads identity and timestamp off an unknown variant's raw form", () => {
    const presented = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    });

    // Nothing parsed these - they come straight off `raw`, which is what lets
    // an uninterpretable row still sort into the transcript.
    expect(presented.messages[2].timestamp).toBe(3);
    expect(presented.events[1].eventId).toBe("e-2");
    expect(presented.events[1].timestamp).toBe(5);
    expect(presented.events[1].raw).toEqual(canonicalizeJsonValue(unknownEvent));
  });

  it("surfaces an unknown block inside a KNOWN assistant message", () => {
    const blocks = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    }).messages[1].blocks;

    expect(blocks.map((block) => block.variant)).toEqual([
      "text",
      "file_change",
      "plan",
      "holodeck",
    ]);
    expect(blocks[0].known).not.toBeNull();
    expect(blocks[3].known).toBeNull();
    expect(blocks[3].blockId).toBe("b-future");
    expect(blocks[3].raw).toEqual(canonicalizeJsonValue(unknownBlock));
  });

  it("renders an unknown message's content as raw rather than guessing at blocks", () => {
    // A role this build never modeled has no blocks field this build may read.
    expect(
      presentChat(chat, { resolvePayload: NO_PAYLOADS_RESOLVABLE }).messages[2]
        .blocks,
    ).toEqual([]);
  });

  it("marks a cloud reader's payload refs as missing", () => {
    const blocks = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    }).messages[1].blocks;

    expect(blocks[1].payloadRefs).toEqual([
      {
        ref: { kind: "file-snapshot", side: "before", hash: "aaa111" },
        availability: "missing",
      },
      {
        ref: { kind: "file-snapshot", side: "after", hash: "bbb222" },
        availability: "missing",
      },
    ]);
    expect(blocks[2].payloadRefs).toEqual([
      { ref: { kind: "plan-content", hash: "ccc333" }, availability: "missing" },
    ]);
  });

  it("lets a reader that CAN fetch them say so", () => {
    const presented = presentChat(chat, {
      resolvePayload: everythingResolvable,
    });

    expect(
      presented.messages[1].blocks[1].payloadRefs.map(
        (payload) => payload.availability,
      ),
    ).toEqual(["resolvable", "resolvable"]);
    expect(presented.fidelity.missingPayloads).toBe(0);
  });

  it("finds no payload refs in a block it cannot interpret", () => {
    // The unknown block may well carry refs; claiming to know which would be
    // guessing at a shape this build has never seen.
    expect(
      presentChat(chat, { resolvePayload: NO_PAYLOADS_RESOLVABLE }).messages[1]
        .blocks[3].payloadRefs,
    ).toEqual([]);
  });

  it("counts what it could not interpret so a surface can say it once", () => {
    expect(
      presentChat(chat, { resolvePayload: NO_PAYLOADS_RESOLVABLE }).fidelity,
    ).toEqual({
      unknownMessages: 1,
      unknownBlocks: 1,
      unknownEvents: 1,
      missingPayloads: 3,
    });
  });

  it("carries the chat's identity, capture point and lineage through unchanged", () => {
    const presented = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    });

    expect(presented.chatId).toBe("chat-1");
    expect(presented.originHostId).toBe("host-origin");
    expect(presented.ownerUserId).toBe("u-1");
    expect(presented.throughRecordSeq).toBe(42);
    expect(presented.capturedAt).toBe(1_700_000_000_000);
    expect(presented.lifecycle.state).toBe("active");
    // Lineage reaches the UI: a fork arbitration surface needs the identity the
    // head chained to, not the seq it happens to carry.
    expect(presented.parentHeadSha256).toBe("f".repeat(64));
  });

  it("interprets a message whose harness id this build has never seen", () => {
    const assistant = presentChat(chat, {
      resolvePayload: NO_PAYLOADS_RESOLVABLE,
    }).messages[1].known;

    // The whole point of reopening the harness enums: an unknown harness must
    // not demote an otherwise ordinary message to "unreadable".
    if (assistant === null || assistant.role !== "assistant") {
      throw new Error("expected an interpreted assistant message");
    }
    expect(assistant.sender.harnessId).toBe("starfleet-cli");
  });

  it("presents a graduated chat exactly as an inline one", async () => {
    const inline = publishChat({
      graduate: { events: false, hostPrivate: false },
      parentHeadSha256: "f".repeat(64),
    });
    const result = await assembleChat({
      head: inline.head,
      readerSupports: CHAT_SYNC_READER_VERSION,
      fetch: inline.fetch,
    });
    if (result.status !== "ok") throw new Error("expected an assembled chat");

    expect(
      presentChat(result.chat, { resolvePayload: NO_PAYLOADS_RESOLVABLE }),
    ).toEqual(presentChat(chat, { resolvePayload: NO_PAYLOADS_RESOLVABLE }));
  });
});

describe("fallback copy", () => {
  it("names the variant so a support report is actionable", () => {
    expect(describeUnknownVariant("block", "holodeck")).toContain("holodeck");
    expect(describeUnknownVariant("message", "telemetry")).toContain("telemetry");
    expect(describeUnknownVariant("event", "warp.engaged")).toContain(
      "warp.engaged",
    );
  });

  it("degrades cleanly when a variant tag is empty", () => {
    expect(describeUnknownVariant("block", "")).not.toContain("()");
  });

  it("states the CAUSE of a missing payload, not just its absence", () => {
    expect(
      describeMissingPayload({
        kind: "file-snapshot",
        side: "before",
        hash: "aaa111",
      }),
    ).toContain("originating device");
    expect(
      describeMissingPayload({ kind: "plan-content", hash: "ccc333" }),
    ).toContain("originating device");
  });
});
