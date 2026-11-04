import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import {
  projectChatServerFrameForVersion,
  type ProjectedChatSubscribeServerFrame,
} from "../chat-frame-compat";

/**
 * `tool_call.feedbackDraft` rides `chat.subscribe@1.42`. The lines below it
 * are released and bind a tool row without the key, so the projector strips
 * the stamp from every row a peer below 1.42 receives; `1.42` sees it.
 */

const STAMP = {
  category: "tool_problem",
  toolName: "traycer_search_chats",
  goal: "find a chat",
  observed: "an opaque error",
  suggestion: null,
  suggestDiagnostics: false,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

const TOOL_BLOCK = { type: "tool_call", blockId: "b-1", feedbackDraft: STAMP };
const TEXT_BLOCK = { type: "text", blockId: "b-2" };
const ROW = { role: "assistant", blocks: [TOOL_BLOCK, TEXT_BLOCK] };

function version(minor: number): SchemaVersion {
  return { major: 1, minor };
}

const recordSchema = z.record(z.string(), z.unknown());

function asRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value);
}

function serverFrame(
  kind: string,
  body: Record<string, unknown>,
): ProjectedChatSubscribeServerFrame {
  return {
    ...body,
    kind,
    hasBinaryPayload: false,
    epicId: "epic-1",
    chatId: "chat-1",
  };
}

function rowsOf(container: unknown): unknown {
  return asRecord(container).messages;
}

const CARRIERS = [
  [
    "a range",
    () => serverFrame("range", { range: { messages: [ROW] } }),
    (frame: unknown) => rowsOf(asRecord(frame).range),
  ],
  [
    "a snapshot's tail",
    () =>
      serverFrame("snapshot", {
        snapshot: { tail: { messages: [ROW] } },
      }),
    (frame: unknown) => rowsOf(asRecord(asRecord(frame).snapshot).tail),
  ],
  [
    "a whole snapshot's chat",
    () =>
      serverFrame("snapshot", {
        snapshot: { chat: { messages: [ROW] } },
      }),
    (frame: unknown) => rowsOf(asRecord(asRecord(frame).snapshot).chat),
  ],
] as const;

describe.each(CARRIERS)(
  "the feedback draft on %s",
  (_carrier, frameOf, rowsIn) => {
    it.each([37, 41])("is stripped for chat.subscribe@1.%i", (minor) => {
      const projected = projectChatServerFrameForVersion(
        frameOf(),
        version(minor),
      );

      expect(rowsIn(projected)).toEqual([
        {
          role: "assistant",
          blocks: [{ type: "tool_call", blockId: "b-1" }, TEXT_BLOCK],
        },
      ]);
    });

    it("reaches chat.subscribe@1.42", () => {
      const frame = frameOf();

      expect(
        rowsIn(projectChatServerFrameForVersion(frame, version(42))),
      ).toEqual([ROW]);
    });
  },
);
