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
  chatSubscribeV119,
  chatSubscribeV120,
  chatSubscribeV121,
  chatSubscribeV122,
  chatSubscribeV123,
  chatSubscribeWindowedClientFrameSchema,
  chatSubscribeWindowedServerFrameSchema,
  openChatSubscribeWindowedServerFrameSchema,
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

describe("chat.subscribe registry: 1.17 installed below the 1.18 through 1.22 lines, 1.16 still installed", () => {
  it("binds 1.17 and 1.16 to their own contracts - the head has since moved to 1.23", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(23);
    expect(line.versions[23].contract).toBe(chatSubscribeV123);
    expect(line.versions[22].contract).toBe(chatSubscribeV122);
    expect(line.versions[21].contract).toBe(chatSubscribeV121);
    expect(line.versions[20].contract).toBe(chatSubscribeV120);
    expect(line.versions[19].contract).toBe(chatSubscribeV119);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
    expect(line.versions[16].contract).toBe(chatSubscribeV116);
  });

  it("1.17, 1.18 and 1.19 keep the live client frames and frozen server frames since 1.20 opened above them", () => {
    // None of `1.18`, `1.19` or `1.20` adds anything a client sends on the
    // stream (`1.19`'s claim is on the open request), so every line from
    // `1.17` binds the live client schema; their server frames are
    // host-authored, so `1.17`'s, `1.18`'s and `1.19`'s froze.
    expect(chatSubscribeV118.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
    expect(chatSubscribeV118.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV117.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
    expect(chatSubscribeV119.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
    expect(chatSubscribeV119.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV120.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    // 1.20 froze when 1.21 opened above it; 1.21 and 1.22 froze when 1.23
    // opened above them, with pre-page bodies (1.22 keeps its open harness
    // leaves); 1.23 binds the open twin a client parses.
    expect(chatSubscribeV120.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV121.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV122.serverFrameSchema).not.toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV123.serverFrameSchema).toBe(
      openChatSubscribeWindowedServerFrameSchema,
    );
  });

  it("1.20 still carries the sender host on its server frames", () => {
    expect(schemaText(chatSubscribeV120.serverFrameSchema)).toContain(
      SENT_FROM_HOST_NEEDLE,
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
