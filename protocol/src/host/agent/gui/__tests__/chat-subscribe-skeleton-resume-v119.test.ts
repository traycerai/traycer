import { describe, expect, it } from "vitest";
import { validateVersionedStreamRpcRegistry } from "@traycer/protocol/framework/versioned-stream-rpc";
import { prepareStreamSubscribeRequest } from "@traycer/protocol/host-transport/remote/stream-codec";
import { hostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  chatSubscribeOpenRequestSchema,
  chatSubscribeOpenRequestSchemaV119,
  chatSubscribeV116,
  chatSubscribeV117,
  chatSubscribeV118,
  chatSubscribeV119,
} from "@traycer/protocol/host/agent/gui/subscribe";
import {
  SKELETON_RESUME_BLOCK_SIZE,
  SKELETON_RESUME_DERIVATION,
} from "@traycer/protocol/persistence/chat-transcript/skeleton-resume";

/**
 * `chat.subscribe@1.19`: skeleton resume. The open request carries the
 * client's `resume` claim and the first chunk of a resumed stream carries
 * `retainedRows`. Main's model-routing `1.18` remains frozen below it.
 * See `subscribe.ts`'s docblock on `chatSubscribeV119` for why
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

describe("chat.subscribe registry: 1.19 the head, 1.18 still installed", () => {
  it("advances latestMinor to 19 and binds the new and previous lines", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(19);
    expect(line.versions[19].contract).toBe(chatSubscribeV119);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
  });

  it("validates the stream registry as constructed", () => {
    expect(() =>
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry),
    ).not.toThrow();
  });
});

describe("chat.subscribe@1.19 open request", () => {
  it("requires the claim to be stated - null or a claim, never absent", () => {
    const open = { epicId: "epic", chatId: "chat" };
    expect(
      chatSubscribeOpenRequestSchemaV119.safeParse({ ...open, resume: null })
        .success,
    ).toBe(true);
    expect(
      chatSubscribeOpenRequestSchemaV119.parse({ ...open, resume: CLAIM }),
    ).toEqual({ ...open, resume: CLAIM });
    expect(chatSubscribeOpenRequestSchemaV119.safeParse(open).success).toBe(
      false,
    );
  });

  it("every line below has no claim to carry", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(chatSubscribeV117.openRequestSchema).toBe(
      chatSubscribeOpenRequestSchema,
    );
    for (let minor = 0; minor < 19; minor += 1) {
      const parsed = line.versions[minor].contract.openRequestSchema.parse({
        epicId: "epic",
        chatId: "chat",
        resume: CLAIM,
      });
      expect(parsed, `1.${minor}`).not.toHaveProperty("resume");
    }
  });

  it("keeps the 1.18 model-routing open request unchanged", () => {
    const open = { epicId: "epic", chatId: "chat" };
    expect(chatSubscribeV118.openRequestSchema.parse(open)).toEqual(open);
    expect(
      chatSubscribeV118.openRequestSchema.safeParse({ ...open, resume: CLAIM })
        .success,
    ).toBe(true);
  });

  it("strips the claim when a 1.19 client declares 1.18 to an older host", () => {
    const prepared = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      "chat.subscribe",
      { major: 1, minor: 19 },
      { major: 1, minor: 18 },
      { epicId: "epic", chatId: "chat", resume: CLAIM },
    );
    expect(prepared.onWireVersion).toEqual({ major: 1, minor: 18 });
    expect(prepared.onWirePayload).toEqual({ epicId: "epic", chatId: "chat" });
  });

  it("carries the claim unchanged between two 1.19 peers", () => {
    const params = { epicId: "epic", chatId: "chat", resume: CLAIM };
    const prepared = prepareStreamSubscribeRequest(
      hostStreamRpcRegistry,
      "chat.subscribe",
      { major: 1, minor: 19 },
      { major: 1, minor: 19 },
      params,
    );
    expect(prepared.onWirePayload).toEqual(params);
  });
});

describe("chat.subscribe@1.19 skeletonChunk carries retainedRows; 1.18 does not", () => {
  it("1.19 parses retainedRows, and an ordinary chunk without it", () => {
    const resumed = chatSubscribeV119.serverFrameSchema.parse(
      skeletonChunkFrame({ retainedRows: 512 }),
    );
    expect(resumed).toMatchObject({ kind: "skeletonChunk", retainedRows: 512 });
    const plain = chatSubscribeV119.serverFrameSchema.parse(
      skeletonChunkFrame({}),
    );
    expect(plain).not.toHaveProperty("retainedRows");
  });

  it("1.19 refuses a retainedRows that is not a positive whole number", () => {
    for (const retainedRows of [0, -256, 1.5]) {
      expect(
        chatSubscribeV119.serverFrameSchema.safeParse(
          skeletonChunkFrame({ retainedRows }),
        ).success,
      ).toBe(false);
    }
  });

  it("1.16-1.18 drop retainedRows as an unknown key rather than refusing the frame", () => {
    for (const contract of [
      chatSubscribeV116,
      chatSubscribeV117,
      chatSubscribeV118,
    ]) {
      const parsed = contract.serverFrameSchema.parse(
        skeletonChunkFrame({ retainedRows: 512 }),
      );
      expect(parsed).toMatchObject({ kind: "skeletonChunk" });
      expect(parsed).not.toHaveProperty("retainedRows");
    }
  });

  it("1.17-1.19 share their client frames - resume is read-only on the wire", () => {
    expect(chatSubscribeV117.clientFrameSchema).toBe(
      chatSubscribeV118.clientFrameSchema,
    );
    expect(chatSubscribeV118.clientFrameSchema).toBe(
      chatSubscribeV119.clientFrameSchema,
    );
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeV118.serverFrameSchema,
    );
  });
});
