/**
 * The host does not schema-parse outbound bytes, so `failure` and the
 * fallback grace-hold lease `token` physically reach every released peer
 * regardless of what the live producer intends. What actually protects a
 * `chat.subscribe@1.0-1.8` client is that ITS OWN decoder is the frozen
 * schema, which strips the unknown key on parse - a Zod object schema is
 * non-strict by default, so an extra key is dropped, not rejected.
 *
 * A grep for `.strict()` proves nothing here: `.strict()` is not deep, and it
 * appears on 194 objects and 84 `z.strictObject`s elsewhere in this package
 * without saying anything about whether THESE composed unions reject or keep
 * an unknown key. The only real evidence is parsing an actual frame through
 * the actual frozen schema and inspecting the parsed object.
 *
 * Imports are namespaced (not named) deliberately: a standalone script hits
 * an import-cycle timing issue where a named import of one of these schemas
 * comes back `undefined`; a namespace import does not.
 */
import { describe, expect, it } from "vitest";
import * as agentRuntime from "../agent-runtime";
import * as contentBlocks from "../../../../persistence/epic/content-blocks";
import * as subscribe from "../subscribe";

function baseRuntimeEventFields() {
  return { blockId: "block-1", timestamp: 1000 };
}

function errorEventWithFailure(): unknown {
  return {
    ...baseRuntimeEventFields(),
    type: "error",
    message: "boom",
    recoverable: false,
    code: "rate_limit",
    failure: { reason: "rate_limit" },
  };
}

function turnInterruptedEventWithFailure(): unknown {
  return {
    ...baseRuntimeEventFields(),
    type: "turn.interrupted",
    turnId: "turn-1",
    reason: "rate_limit",
    failure: { reason: "rate_limit" },
  };
}

describe("runtime-event unions bound to released chat.subscribe lines strip `failure`", () => {
  const unions = [
    [
      "runtimeEventSchemaPreImage (1.4/1.5)",
      agentRuntime.runtimeEventSchemaPreImage,
    ],
    [
      "runtimeEventSchemaPreSettlement (1.6)",
      agentRuntime.runtimeEventSchemaPreSettlement,
    ],
    [
      "runtimeEventSchemaPreFallback (1.7/1.8)",
      agentRuntime.runtimeEventSchemaPreFallback,
    ],
  ] as const;

  for (const [label, union] of unions) {
    it(`${label}: parses an error event with 'failure' present and strips the key rather than rejecting`, () => {
      const parsed = union.parse(errorEventWithFailure());
      expect(parsed.type).toBe("error");
      expect(Object.prototype.hasOwnProperty.call(parsed, "failure")).toBe(
        false,
      );
    });

    it(`${label}: parses a turn.interrupted event with 'failure' present and strips the key rather than rejecting`, () => {
      const parsed = union.parse(turnInterruptedEventWithFailure());
      expect(parsed.type).toBe("turn.interrupted");
      expect(Object.prototype.hasOwnProperty.call(parsed, "failure")).toBe(
        false,
      );
    });
  }

  it("the live runtimeEventSchema keeps 'failure' on both terminal members - the positive control for the strips above", () => {
    const error = agentRuntime.runtimeEventSchema.parse(
      errorEventWithFailure(),
    );
    expect(error).toMatchObject({ failure: { reason: "rate_limit" } });
    const interrupted = agentRuntime.runtimeEventSchema.parse(
      turnInterruptedEventWithFailure(),
    );
    expect(interrupted).toMatchObject({ failure: { reason: "rate_limit" } });
  });
});

function errorBlockWithFailure(): unknown {
  return {
    type: "error",
    blockId: "block-1",
    status: "errored",
    timestamp: 1000,
    message: "boom",
    recoverable: false,
    code: "rate_limit",
    failure: { reason: "rate_limit" },
  };
}

describe("content-block unions bound to released chat-tree snapshots strip `failure` on an error block", () => {
  const unions = [
    ["contentBlockSchemaPreImage", contentBlocks.contentBlockSchemaPreImage],
    [
      "contentBlockSchemaPreSettlement",
      contentBlocks.contentBlockSchemaPreSettlement,
    ],
    [
      "contentBlockSchemaPreFallback",
      contentBlocks.contentBlockSchemaPreFallback,
    ],
  ] as const;

  for (const [label, union] of unions) {
    it(`${label}: parses an error block with 'failure' present and strips the key rather than rejecting`, () => {
      const parsed = union.parse(errorBlockWithFailure());
      expect(parsed.type).toBe("error");
      expect(Object.prototype.hasOwnProperty.call(parsed, "failure")).toBe(
        false,
      );
    });
  }

  it("the live contentBlockSchema keeps 'failure' on an error block - the positive control for the strips above", () => {
    const parsed = contentBlocks.contentBlockSchema.parse(
      errorBlockWithFailure(),
    );
    expect(parsed).toMatchObject({ failure: { reason: "rate_limit" } });
  });
});

function actionAckFrameWithToken(): unknown {
  return {
    kind: "actionAck",
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
    clientActionId: "action-1",
    action: "stop",
    status: "accepted",
    reason: null,
    code: null,
    token: "lease-token-abc",
  };
}

describe("actionAck lease `token` strips on the released non-windowed lines and survives on the live windowed line", () => {
  const strippingLines = [
    ["chatSubscribeV16", subscribe.chatSubscribeV16],
    ["chatSubscribeV17", subscribe.chatSubscribeV17],
    ["chatSubscribeV18", subscribe.chatSubscribeV18],
  ] as const;

  for (const [label, contract] of strippingLines) {
    it(`${label}.serverFrameSchema strips 'token' from a parsed actionAck frame`, () => {
      const parsed = contract.serverFrameSchema.parse(
        actionAckFrameWithToken(),
      );
      expect(parsed).toMatchObject({ kind: "actionAck" });
      expect(Object.prototype.hasOwnProperty.call(parsed, "token")).toBe(false);
    });
  }

  it("chatSubscribeV19.serverFrameSchema keeps 'token' - the positive control that pins both directions at once", () => {
    const parsed = subscribe.chatSubscribeV19.serverFrameSchema.parse(
      actionAckFrameWithToken(),
    );
    expect(parsed).toMatchObject({
      kind: "actionAck",
      token: "lease-token-abc",
    });
  });
});
