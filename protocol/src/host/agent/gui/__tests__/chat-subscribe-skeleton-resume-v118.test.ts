import { describe, expect, it } from "vitest";
import { validateVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { prepareStreamSubscribeRequest } from "@traycer/protocol/host-transport/remote/stream-codec";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeOpenRequestSchema,
  chatSubscribeOpenRequestSchemaV118,
  chatSubscribeV117,
  chatSubscribeV118,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  SKELETON_RESUME_BLOCK_SIZE,
  SKELETON_RESUME_DERIVATION,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";

/**
 * `chat.subscribe@1.18`: skeleton resume. The open request carries the
 * client's `resume` claim and the first chunk of a resumed stream carries
 * `retainedRows`. See `subscribe.ts`'s docblock on `chatSubscribeV118` for why
 * both directions degrade to a full stream against an older peer, which is
 * what this file pins.
 */

const CLAIM = {
  derivation: SKELETON_RESUME_DERIVATION,
  blockSize: SKELETON_RESUME_BLOCK_SIZE,
  blockDigests: ["abc1234", "def5678"],
};

function skeletonChunkFrame(extra: Record<string, number>) {
  return {
    kind: "skeletonChunk",
    hasBinaryPayload: false,
    epicId: "epic",
    chatId: "chat",
    chunk: {
      epoch: 0,
      fromOrdinal: 512,
      entries: [],
      isFinal: true,
    },
    ...extra,
  };
}

describe("chat.subscribe registry: 1.18 the head, 1.17 still installed", () => {
  it("advances latestMinor to 18 and binds the new and previous lines", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(18);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
  });

  it("validates the stream registry as constructed", () => {
    expect(() =>
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry),
    ).not.toThrow();
  });
});

describe("chat.subscribe@1.18 open request", () => {
  it("requires the claim to be stated - null or a claim, never absent", () => {
    const open = { epicId: "epic", chatId: "chat" };
    expect(
      chatSubscribeOpenRequestSchemaV118.safeParse({ ...open, resume: null })
        .success,
    ).toBe(true);
    expect(
      chatSubscribeOpenRequestSchemaV118.parse({ ...open, resume: CLAIM }),
    ).toEqual({ ...open, resume: CLAIM });
    expect(chatSubscribeOpenRequestSchemaV118.safeParse(open).success).toBe(
      false,
    );
  });

  it("every line below has no claim to carry", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(chatSubscribeV117.openRequestSchema).toBe(
      chatSubscribeOpenRequestSchema,
    );
    for (let minor = 0; minor < 18; minor += 1) {
      const parsed = line.versions[minor].contract.openRequestSchema.parse({
        epicId: "epic",
        chatId: "chat",
        resume: CLAIM,
      });
      expect(parsed, `1.${minor}`).not.toHaveProperty("resume");
    }
  });

  it("strips the claim when a 1.18 client declares 1.17 to an older host", () => {
    const prepared = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      "chat.subscribe",
      { major: 1, minor: 18 },
      { major: 1, minor: 17 },
      { epicId: "epic", chatId: "chat", resume: CLAIM },
    );
    expect(prepared.onWireVersion).toEqual({ major: 1, minor: 17 });
    expect(prepared.onWirePayload).toEqual({ epicId: "epic", chatId: "chat" });
  });

  it("carries the claim unchanged between two 1.18 peers", () => {
    const params = { epicId: "epic", chatId: "chat", resume: CLAIM };
    const prepared = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      "chat.subscribe",
      { major: 1, minor: 18 },
      { major: 1, minor: 18 },
      params,
    );
    expect(prepared.onWirePayload).toEqual(params);
  });
});

describe("chat.subscribe@1.18 skeletonChunk carries retainedRows; 1.17 does not", () => {
  it("1.18 parses retainedRows, and an ordinary chunk without it", () => {
    const resumed = chatSubscribeV118.serverFrameSchema.parse(
      skeletonChunkFrame({ retainedRows: 512 }),
    );
    expect(resumed).toMatchObject({ kind: "skeletonChunk", retainedRows: 512 });
    const plain = chatSubscribeV118.serverFrameSchema.parse(
      skeletonChunkFrame({}),
    );
    expect(plain).not.toHaveProperty("retainedRows");
  });

  it("1.18 refuses a retainedRows that is not a positive whole number", () => {
    for (const retainedRows of [0, -256, 1.5]) {
      expect(
        chatSubscribeV118.serverFrameSchema.safeParse(
          skeletonChunkFrame({ retainedRows }),
        ).success,
      ).toBe(false);
    }
  });

  it("1.17 drops retainedRows as an unknown key rather than refusing the frame", () => {
    const parsed = chatSubscribeV117.serverFrameSchema.parse(
      skeletonChunkFrame({ retainedRows: 512 }),
    );
    expect(parsed).toMatchObject({ kind: "skeletonChunk" });
    expect(parsed).not.toHaveProperty("retainedRows");
  });

  it("1.17 and 1.18 share their client frames - resume is read-only on the wire", () => {
    expect(chatSubscribeV117.clientFrameSchema).toBe(
      chatSubscribeV118.clientFrameSchema,
    );
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeV118.serverFrameSchema,
    );
  });
});
