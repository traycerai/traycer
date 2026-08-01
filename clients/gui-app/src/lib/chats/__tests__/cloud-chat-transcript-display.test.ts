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
  type PresentedChat,
} from "@traycer/protocol/persistence/chat-sync/presentation";
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
