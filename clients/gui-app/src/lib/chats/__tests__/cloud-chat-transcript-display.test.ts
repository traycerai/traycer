import { describe, expect, it } from "vitest";
import { readCloudChat } from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import { resolverFromPayloadRefs } from "@traycer-clients/shared/cloud-chat/payloads";
import {
  DEFAULT_PUBLISH,
  IDENTITY,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import {
  NO_PAYLOADS_RESOLVABLE,
  presentChat,
  type PresentedContentBlock,
  type PresentedChat,
  type PresentedChatEvent,
} from "@traycer/protocol/persistence/chat-sync/presentation";
import {
  snapshotChatEventSchema,
  snapshotContentBlockSchema,
} from "@traycer/protocol/persistence/chat-sync/open-harness";
import {
  buildCloudChatTranscript,
  describeTranscriptFidelity,
} from "@/lib/chats/cloud-chat-transcript-display";

/**
 * The transcript rows, driven off a chat that went through the REAL read path.
 *
 * Building a `PresentedChat` by hand would be faster and would test nothing:
 * the interesting rows here exist because a shard carried a variant this build
 * has never heard of, and only the actual parse-and-assemble produces one of
 * those with its `raw` intact.
 */

async function present(options: {
  readonly resolvable: readonly { kind: string; sha256: string }[] | null;
}): Promise<PresentedChat> {
  const published = await publishCloudChat(DEFAULT_PUBLISH);
  const result = await readCloudChat({
    identity: IDENTITY,
    port: recordingPort(servingBehaviour(published)),
    cache: new InMemoryChatPartCache(),
    sha256Hex: webCryptoSha256Hex,
  });
  if (result.outcome.kind !== "ok") {
    throw new Error(`Fixture chat did not read: ${result.outcome.kind}`);
  }
  return presentChat(result.outcome.chat, {
    resolvePayload:
      options.resolvable === null
        ? NO_PAYLOADS_RESOLVABLE
        : resolverFromPayloadRefs(options.resolvable),
  });
}

function codexRetryBlock(
  presented: PresentedChat,
  input: {
    readonly blockId: string;
    readonly code: string;
    readonly message: string;
  },
): PresentedContentBlock {
  const template = presented.messages
    .flatMap((message) => message.blocks)
    .at(0);
  if (template === undefined) throw new Error("Fixture chat has no block");
  const raw = {
    ...template.raw,
    blockId: input.blockId,
    status: "errored",
    timestamp: 20,
    type: "error",
    message: input.message,
    recoverable: true,
    code: input.code,
    failure: null,
  };
  return {
    ...template,
    blockId: input.blockId,
    variant: "error",
    known: snapshotContentBlockSchema.parse(raw),
    raw,
    payloadRefs: [],
  };
}

function turnEvent(
  template: PresentedChatEvent,
  type: "turn.started" | "turn.completed",
  turnId: string,
): PresentedChatEvent {
  if (template.known === null) throw new Error("Fixture event is unknown");
  return {
    ...template,
    known: snapshotChatEventSchema.parse({
      ...template.known,
      type,
      turnId,
    }),
  };
}

function firstEvent(presented: PresentedChat): PresentedChatEvent {
  const event = presented.events.at(0);
  if (event === undefined) throw new Error("Fixture chat has no event");
  return event;
}

function codexRetryChat(
  presented: PresentedChat,
  input: {
    readonly turnId: string;
    readonly blocks: readonly PresentedContentBlock[];
    readonly events: readonly PresentedChatEvent[];
  },
): PresentedChat {
  const assistantIndex = presented.messages.findIndex(
    (message) => message.known?.role === "assistant",
  );
  if (assistantIndex === -1) throw new Error("Fixture chat has no assistant");
  const assistant = presented.messages.at(assistantIndex);
  if (assistant?.known?.role !== "assistant") {
    throw new Error("Fixture assistant is not known");
  }
  const known = {
    ...assistant.known,
    sender: { ...assistant.known.sender, harnessId: "codex" },
    turnId: input.turnId,
  };
  return {
    ...presented,
    messages: presented.messages.map((message, index) =>
      index === assistantIndex
        ? { ...message, known, blocks: input.blocks }
        : message,
    ),
    events: input.events,
  };
}

describe("nothing is dropped", () => {
  it("gives an unknown block type a row of its own", async () => {
    const transcript = buildCloudChatTranscript(
      await present({ resolvable: null }),
    );

    const assistant = transcript.messages[1];
    // Three blocks published, three rows - a dropped block is indistinguishable
    // from a chat that never had one.
    expect(assistant.blocks).toHaveLength(3);
    const unknown = assistant.blocks.filter((block) => block.isUnknown);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].label).toContain("holodeck");
    expect(unknown[0].label).toContain("newer version of Traycer");
  });

  it("keeps every row's key unique even where the record carries no id", async () => {
    const transcript = buildCloudChatTranscript(
      await present({ resolvable: null }),
    );

    const keys = transcript.messages.flatMap((message) => [
      message.key,
      ...message.blocks.map((block) => block.key),
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders known blocks through their own summaries", async () => {
    const transcript = buildCloudChatTranscript(
      await present({ resolvable: null }),
    );

    const labels = transcript.messages[1].blocks.map((block) => block.label);
    expect(labels[0]).toBe("Response");
    expect(labels[1]).toBe("File · src/app.ts");
  });
});

describe("payload markers", () => {
  it("states the gap explicitly for a payload it cannot fetch", async () => {
    const transcript = buildCloudChatTranscript(
      await present({ resolvable: null }),
    );

    const fileBlock = transcript.messages[1].blocks[1];
    // Two - before and after. Rendered as sentences rather than left as a blank
    // card, because a blank card reads as "this chat has no diff".
    expect(fileBlock.missingPayloads).toHaveLength(2);
    expect(fileBlock.missingPayloads[0]).toContain("originating device");
    expect(fileBlock.fetchablePayloads).toEqual([]);
  });

  it("offers a fetch control per SIDE, so two are distinguishable", async () => {
    const transcript = buildCloudChatTranscript(
      await present({
        resolvable: [
          { kind: "file-snapshot", sha256: "aaa111" },
          { kind: "file-snapshot", sha256: "bbb222" },
        ],
      }),
    );

    const fileBlock = transcript.messages[1].blocks[1];
    expect(fileBlock.missingPayloads).toEqual([]);
    expect(fileBlock.fetchablePayloads.map((entry) => entry.label)).toEqual([
      "File contents (before)",
      "File contents (after)",
    ]);
    // Distinct keys even though a file whose before and after are identical
    // would carry the SAME digest twice.
    expect(fileBlock.fetchablePayloads[0].key).not.toBe(
      fileBlock.fetchablePayloads[1].key,
    );
  });
});

describe("the fidelity line", () => {
  it("counts what could not be rendered, once, at the top", async () => {
    const notice = describeTranscriptFidelity(
      await present({ resolvable: null }),
    );

    expect(notice).toBe(
      "1 item needs a newer version of Traycer · 2 attachments are stored on the originating device",
    );
  });

  it("is null when nothing was lost", async () => {
    const presented = await present({
      resolvable: [
        { kind: "file-snapshot", sha256: "aaa111" },
        { kind: "file-snapshot", sha256: "bbb222" },
      ],
    });
    // The fixture still carries an unknown block, so the honest way to reach
    // "nothing lost" is a chat that has none.
    const lossless: PresentedChat = {
      ...presented,
      fidelity: {
        unknownMessages: 0,
        unknownBlocks: 0,
        unknownEvents: 0,
        missingPayloads: 0,
      },
    };

    expect(describeTranscriptFidelity(lossless)).toBeNull();
  });
});

describe("Codex retry presentation", () => {
  it("treats a later turn.started as live after prior terminal evidence", async () => {
    const presented = await present({ resolvable: null });
    const turnId = "turn-retry-restarted";
    const retry = codexRetryBlock(presented, {
      blockId: "retry-restarted",
      code: "RETRY_IN_PROGRESS",
      message: "Provider overloaded; retrying",
    });
    const transcript = buildCloudChatTranscript(
      codexRetryChat(presented, {
        turnId,
        blocks: [retry],
        events: [
          turnEvent(firstEvent(presented), "turn.completed", turnId),
          turnEvent(firstEvent(presented), "turn.started", turnId),
        ],
      }),
    );

    const assistant = transcript.messages.find(
      (message) => message.variant === "assistant",
    );
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Retrying",
          details: ["Retrying automatically. · Reported by Codex"],
        }),
      ]),
    );
  });

  it("hides an all-hidden retry message without shifting later row keys", async () => {
    const presented = await present({ resolvable: null });
    const turnId = "turn-retry-finished";
    const retry = codexRetryBlock(presented, {
      blockId: "retry-finished",
      code: "RETRY_ENDED",
      message: "The Codex retry attempt ended.",
    });
    const transcript = buildCloudChatTranscript(
      codexRetryChat(presented, {
        turnId,
        blocks: [retry],
        events: [turnEvent(firstEvent(presented), "turn.completed", turnId)],
      }),
    );

    expect(transcript.messages.map((message) => message.key)).toEqual([
      "m:0:m-user",
      "m:2:m-user-2",
      "m:3:m-assistant-2",
    ]);
  });

  it("labels a final Codex error with provider context", async () => {
    const presented = await present({ resolvable: null });
    const error = codexRetryBlock(presented, {
      blockId: "codex-final-error",
      code: "PROVIDER_AUTH_FAILED",
      message: "Provider authentication failed",
    });
    const transcript = buildCloudChatTranscript(
      codexRetryChat(presented, {
        turnId: "turn-final-error",
        blocks: [error],
        events: [],
      }),
    );

    const assistant = transcript.messages.find(
      (message) => message.variant === "assistant",
    );
    expect(assistant?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Codex turn failed",
          body: "Provider authentication failed",
        }),
      ]),
    );
  });
});

describe("a subagent's parented rows", () => {
  function proseBlock(
    template: PresentedContentBlock,
    input: {
      readonly blockId: string;
      readonly variant: "text" | "reasoning";
      readonly parentBlockId: string | null;
    },
  ): PresentedContentBlock {
    const body =
      input.variant === "text"
        ? { text: "some words", providerNotice: null }
        : { content: "some thoughts", startedAt: null };
    const raw = {
      blockId: input.blockId,
      status: "completed",
      timestamp: 21,
      type: input.variant,
      ...body,
      ...(input.parentBlockId === null
        ? {}
        : { parentBlockId: input.parentBlockId }),
    };
    return {
      ...template,
      blockId: input.blockId,
      variant: input.variant,
      known: snapshotContentBlockSchema.parse(raw),
      raw,
      payloadRefs: [],
    };
  }

  it("labels parented text and reasoning as the subagent's, and unparented ones as before", async () => {
    const presented = await present({ resolvable: null });
    const template = presented.messages
      .flatMap((message) => message.blocks)
      .at(0);
    if (template === undefined) throw new Error("Fixture chat has no block");
    const chat = codexRetryChat(presented, {
      turnId: "turn-subagent-labels",
      blocks: [
        proseBlock(template, {
          blockId: "t-parented",
          variant: "text",
          parentBlockId: "task-1",
        }),
        proseBlock(template, {
          blockId: "r-parented",
          variant: "reasoning",
          parentBlockId: "task-1",
        }),
        proseBlock(template, {
          blockId: "t-plain",
          variant: "text",
          parentBlockId: null,
        }),
        proseBlock(template, {
          blockId: "r-plain",
          variant: "reasoning",
          parentBlockId: null,
        }),
      ],
      events: [],
    });

    const transcript = buildCloudChatTranscript(chat);
    const labels = transcript.messages[1].blocks.map((block) => block.label);

    expect(labels).toEqual([
      "Subagent · Response",
      "Subagent · Thinking",
      "Response",
      "Thinking",
    ]);
  });
});
