import { describe, expect, it } from "vitest";
import { AUTH_ERROR_CODE } from "@traycer/protocol/host/agent/gui/agent-runtime";
import { latestAssistantAuthFailureTurnKey } from "@traycer/protocol/persistence/chat-transcript/provider-auth-failure";
import type { ContentBlock } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  assistantMessageSchema,
  userMessageSchema,
  type AssistantMessage,
  type UserMessage,
} from "@traycer/protocol/persistence/epic/messages";

/**
 * The selection BOTH lines run - the renderer over a legacy peer's full record
 * array, the host over the whole transcript - so a chat mounts the re-auth
 * banner identically whichever host serves it.
 *
 * These pin the shape of the answer, not just its truth value: the key is what
 * the store dedupes on, and getting it wrong turns "nudge once per failure"
 * into either a nudge storm or a single nudge for the lifetime of the store.
 */

const AGENT_SENDER = {
  type: "agent" as const,
  harnessId: "claude",
  agentId: "agent-1",
  displayName: "Claude",
};

const USER_SENDER = { type: "user" as const, userId: "user-1" };

function errorBlock(blockId: string, code: string | null): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp: 1,
    type: "error" as const,
    message: "boom",
    recoverable: true,
    code,
  };
}

function textBlock(blockId: string): ContentBlock {
  return {
    blockId,
    status: "completed" as const,
    timestamp: 1,
    type: "text" as const,
    text: "hi",
    providerNotice: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string | null;
  blocks: ReadonlyArray<ContentBlock>;
}): AssistantMessage {
  return assistantMessageSchema.parse({
    role: "assistant",
    messageId: input.messageId,
    sender: AGENT_SENDER,
    blocks: input.blocks,
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
  });
}

function userMessage(messageId: string, timestamp: number): UserMessage {
  return userMessageSchema.parse({
    role: "user",
    messageId,
    sender: USER_SENDER,
    message: { kind: "user", content: { type: "doc" } },
    timestamp,
    sessionAnchor: null,
  });
}

describe("latestAssistantAuthFailureTurnKey", () => {
  it("returns the failed turn's id", () => {
    expect(
      latestAssistantAuthFailureTurnKey([
        userMessage("u-1", 1),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2,
          turnId: "turn-1",
          blocks: [errorBlock("b-1", AUTH_ERROR_CODE)],
        }),
      ]),
    ).toBe("turn-1");
  });

  it("is not hidden by trailing user rows", () => {
    // The exact shape the windowed line breaks on: the failing assistant
    // record sits several rows back, so it is the first thing an inline tail
    // drops - and the legacy suite already covers it, which is why the two
    // lines have to answer the same.
    expect(
      latestAssistantAuthFailureTurnKey([
        assistantMessage({
          messageId: "a-1",
          timestamp: 1,
          turnId: "turn-1",
          blocks: [errorBlock("b-1", AUTH_ERROR_CODE)],
        }),
        userMessage("u-1", 2),
        userMessage("u-2", 3),
      ]),
    ).toBe("turn-1");
  });

  it("is silent when a LATER turn succeeded", () => {
    // A recovered chat keeps its failure rows forever. What decides whether
    // the credential is broken now is the most recent turn.
    expect(
      latestAssistantAuthFailureTurnKey([
        assistantMessage({
          messageId: "a-1",
          timestamp: 1,
          turnId: "turn-1",
          blocks: [errorBlock("b-1", AUTH_ERROR_CODE)],
        }),
        assistantMessage({
          messageId: "a-2",
          timestamp: 2,
          turnId: "turn-2",
          blocks: [textBlock("b-2")],
        }),
      ]),
    ).toBeNull();
  });

  it("ignores an error block with another code", () => {
    expect(
      latestAssistantAuthFailureTurnKey([
        assistantMessage({
          messageId: "a-1",
          timestamp: 1,
          turnId: "turn-1",
          blocks: [errorBlock("b-1", "rate_limit")],
        }),
      ]),
    ).toBeNull();
  });

  it("ignores an error block whose code is null", () => {
    expect(
      latestAssistantAuthFailureTurnKey([
        assistantMessage({
          messageId: "a-1",
          timestamp: 1,
          turnId: "turn-1",
          blocks: [errorBlock("b-1", null)],
        }),
      ]),
    ).toBeNull();
  });

  it("falls back to the record id for a turnId-less record", () => {
    // NOT `assistantTurnKey`'s `ts:<timestamp>` fallback. The key exists to
    // dedupe against the LIVE path's marker, which is the turn the runtime
    // named; a record that never had one dedupes by identity instead.
    expect(
      latestAssistantAuthFailureTurnKey([
        assistantMessage({
          messageId: "a-1",
          timestamp: 1,
          turnId: null,
          blocks: [errorBlock("b-1", AUTH_ERROR_CODE)],
        }),
      ]),
    ).toBe("a-1");
  });

  it("is silent for a transcript with no assistant record", () => {
    expect(
      latestAssistantAuthFailureTurnKey([userMessage("u-1", 1)]),
    ).toBeNull();
    expect(latestAssistantAuthFailureTurnKey([])).toBeNull();
  });
});
