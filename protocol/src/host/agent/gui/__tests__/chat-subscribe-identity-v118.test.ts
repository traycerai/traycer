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
 * `chat.subscribe@1.18`: the bound-identity line. `identityId` appears on the
 * active turn - on the snapshot and on `turnStateChanged` - and on NO line
 * below. See `subscribe.ts`'s docblocks on `chatSubscribeV118` and
 * `chatActiveTurnSchema` for the TOLERANCE (not projection) contract, and
 * `chat-schema-checkpoints.test.ts` for why the key opens a new minor rather
 * than riding `1.13`-`1.17` in place.
 *
 * The needle is anchored to the active turn's own `sameTurnSteeringSupported`
 * key, because `"identityId":` alone also matches the run-settings tuple on
 * the chat record, which every line from `1.13` up already carries.
 */

const ACTIVE_TURN_IDENTITY_NEEDLE =
  /"sameTurnSteeringSupported":\{[^{}]*\},"identityId":/;

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
  { label: "1.17", contract: chatSubscribeV117 },
] as const;

describe("chat.subscribe registry: 1.18 the head, 1.17 still installed", () => {
  it("advances latestMinor to 18 and binds the new and previous lines", () => {
    const line = hostStreamRpcRegistry["chat.subscribe"][1];
    expect(line.latestMinor).toBe(18);
    expect(line.versions[18].contract).toBe(chatSubscribeV118);
    expect(line.versions[17].contract).toBe(chatSubscribeV117);
  });

  it("1.18 binds the live windowed schemas on both sides", () => {
    expect(chatSubscribeV118.serverFrameSchema).toBe(
      chatSubscribeWindowedServerFrameSchema,
    );
    expect(chatSubscribeV118.clientFrameSchema).toBe(
      chatSubscribeWindowedClientFrameSchema,
    );
  });

  it("1.17 and 1.18 share one client schema - the identity on the turn is host-authored", () => {
    expect(chatSubscribeV117.clientFrameSchema).toBe(
      chatSubscribeV118.clientFrameSchema,
    );
    expect(chatSubscribeV117.serverFrameSchema).not.toBe(
      chatSubscribeV118.serverFrameSchema,
    );
  });

  it("validates the stream registry as constructed", () => {
    expect(() =>
      validateVersionedStreamRpcRegistry(hostStreamRpcRegistry),
    ).not.toThrow();
  });
});

describe("chat.subscribe@1.18 carries identityId on the active turn; every line below does not", () => {
  it("1.18's server surface carries the key", () => {
    expect(schemaText(chatSubscribeV118.serverFrameSchema)).toMatch(
      ACTIVE_TURN_IDENTITY_NEEDLE,
    );
  });

  for (const { label, contract } of PRE_KEY_LINES) {
    it(`${label}'s server surface has no such key on the active turn`, () => {
      expect(schemaText(contract.serverFrameSchema)).not.toMatch(
        ACTIVE_TURN_IDENTITY_NEEDLE,
      );
    });
  }
});

describe("chat.subscribe@1.18 turnStateChanged: the key is tolerated, not required", () => {
  const activeTurn = {
    turnId: "turn-1",
    status: "running",
    harnessId: "codex",
    model: "gpt-5.4",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    userMessageId: "message-1",
    startedAt: 1_000,
    updatedAt: 1_000,
    sameTurnSteeringSupported: true,
  };
  const frame = {
    kind: "turnStateChanged",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    runStatus: "running",
    activeTurn,
  };

  function parsedActiveTurn(
    contract: typeof chatSubscribeV117 | typeof chatSubscribeV118,
    input: Record<string, unknown>,
  ): Record<string, unknown> {
    const parsed = contract.serverFrameSchema.parse(input);
    if (parsed.kind !== "turnStateChanged" || parsed.activeTurn === null) {
      throw new Error("expected a turnStateChanged frame with an active turn");
    }
    return parsed.activeTurn;
  }

  it("a 1.18 turn without the key parses with identityId null", () => {
    expect(parsedActiveTurn(chatSubscribeV118, frame)).toHaveProperty(
      "identityId",
      null,
    );
  });

  it("a 1.18 turn naming an identity keeps it", () => {
    expect(
      parsedActiveTurn(chatSubscribeV118, {
        ...frame,
        activeTurn: { ...activeTurn, identityId: "identity_a" },
      }),
    ).toHaveProperty("identityId", "identity_a");
  });

  it("a 1.17 turn naming an identity is parsed WITHOUT the key - the line has no such member", () => {
    // The pre-key object is non-strict, so the unknown member is dropped
    // rather than refused; a `1.17` client's decoder never sees it.
    expect(
      parsedActiveTurn(chatSubscribeV117, {
        ...frame,
        activeTurn: { ...activeTurn, identityId: "identity_a" },
      }),
    ).not.toHaveProperty("identityId");
  });
});
