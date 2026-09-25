import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeV113,
  chatSubscribeV114,
  chatSubscribeV115,
  chatSubscribeV116,
  chatSubscribeV117,
  chatSubscribeV118,
  chatSubscribeWindowedClientFrameSchema,
  chatSubscribeWindowedServerFrameSchema,
} from "@traycer/protocol/host/agent/gui/subscribe";

/**
 * `chat.subscribe@1.17`: the sender-host line. `sentFromHostId` appears on
 * the `send` / `editUserMessage` client frames and on the queued prompt item
 * the host echoes back, and on NO line below. See `subscribe.ts`'s docblocks
 * on `chatSubscribeV117` and `sentFromHostIdFrameField` for the TOLERANCE
 * (not projection) contract, and `chat-schema-checkpoints.test.ts` for why
 * the key had to open a new minor rather than ride `1.13`-`1.16` in place.
 */

// Matched with its colon, so the needle cannot hit a description that merely
// mentions the name.
const SENT_FROM_HOST_NEEDLE = '"sentFromHostId":';

function schemaText(schema: z.ZodType): string {
  return (["input", "output"] as const)
    .map((io) =>
      JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" })),
    )
    .join("\n");
}

const PRE_KEY_LINES = [
  { label: "1.13", contract: chatSubscribeV113 },
  { label: "1.14", contract: chatSubscribeV114 },
  { label: "1.15", contract: chatSubscribeV115 },
  { label: "1.16", contract: chatSubscribeV116 },
] as const;

describe("chat.subscribe registry: 1.17 below the 1.18 head, 1.16 still installed", () => {
  it("binds 1.17 and the previous line - the head has since moved to 1.18", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(18);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
    expect(line.versions[16].contract).toBe(chatSubscribeV116);
  });

  it("1.17 keeps the live client frames and a frozen server union below 1.18's", () => {
    // Skeleton resume (`1.18`) changed only the server's `skeletonChunk` arm,
    // so `1.17` froze its server union and still binds the live client one.
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV118.serverFrameSchema).toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV117.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
    expect(chatSubscribeV118.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
  });

  it("1.15 and 1.16 share one pre-key client schema, distinct from 1.17's", () => {
    expect(chatSubscribeV115.clientFrameSchema).toBe(
      chatSubscribeV116.clientFrameSchema,
    );
    expect(chatSubscribeV116.clientFrameSchema).not.toBe(
      chatSubscribeV117.clientFrameSchema,
    );
  });

  it("validates the stream registry as constructed", () => {
    expect(() =>
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry),
    ).not.toThrow();
  });
});

describe("chat.subscribe@1.17 carries sentFromHostId; every line below does not", () => {
  it("1.17's client and server surfaces both carry the key", () => {
    expect(schemaText(chatSubscribeV117.clientFrameSchema)).toContain(
      SENT_FROM_HOST_NEEDLE,
    );
    expect(schemaText(chatSubscribeV117.serverFrameSchema)).toContain(
      SENT_FROM_HOST_NEEDLE,
    );
  });

  for (const { label, contract } of PRE_KEY_LINES) {
    it(`${label} carries the key on neither side`, () => {
      expect(schemaText(contract.clientFrameSchema)).not.toContain(
        SENT_FROM_HOST_NEEDLE,
      );
      expect(schemaText(contract.serverFrameSchema)).not.toContain(
        SENT_FROM_HOST_NEEDLE,
      );
    });
  }
});

describe("chat.subscribe@1.17 client frames: the key is tolerated, not required", () => {
  const sendFrame = {
    kind: "send",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    messageId: "message-1",
    content: { type: "doc", content: [] },
    sender: { type: "user", userId: "user-1" },
    settings: {
      harnessId: "codex",
      model: "gpt-5.4",
      permissionMode: "supervised",
      reasoningEffort: "high",
      serviceTier: null,
      agentMode: "epic",
      profileId: null,
    },
    accountContext: { type: "PERSONAL" },
    deliveryPolicy: "auto",
    worktreeIntent: null,
    browserAnnotations: [],
  };

  it("a 1.17 send without the key parses with sentFromHostId null", () => {
    const parsed = chatSubscribeV117.clientFrameSchema.parse(sendFrame);
    expect(parsed).toHaveProperty("sentFromHostId", null);
  });

  it("a 1.17 send naming a machine keeps it", () => {
    const parsed = chatSubscribeV117.clientFrameSchema.parse({
      ...sendFrame,
      sentFromHostId: "host-mac",
    });
    expect(parsed).toHaveProperty("sentFromHostId", "host-mac");
  });

  it("a 1.16 send naming a machine is parsed WITHOUT the key - the line has no such member", () => {
    // The pre-key object is non-strict, so the unknown member is dropped
    // rather than refused; the host's live re-parse then fills `null`. A
    // peer on `1.16` cannot name a machine.
    const parsed = chatSubscribeV116.clientFrameSchema.parse({
      ...sendFrame,
      sentFromHostId: "host-mac",
    });
    expect(parsed).not.toHaveProperty("sentFromHostId");
  });
});
