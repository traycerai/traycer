import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { latestForkableAssistantMessageId as protocolLatestForkableAssistantMessageId } from "@traycer/protocol/persistence/chat-transcript/fork-boundary";
import { projectTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
import { latestForkableAssistantMessageId as rendererLatestForkableAssistantMessageId } from "@/components/epic-canvas/renderers/chat-tile-session-state";

/**
 * The host derives `latestForkableAssistantMessageId` (protocol
 * `fork-boundary.ts`) from the raw persisted transcript, while a
 * full-materialized renderer keeps computing the same answer itself by
 * scanning its own `renderedMessages` output (`chat-tile-session-state.ts`).
 * Both paths must agree - see the module doc on `fork-boundary.ts` for why the
 * derivation is shared code in the first place. These tests run a fixture
 * through BOTH paths and assert they land on the same id, so a change to
 * either the renderer's turn-lifecycle fold or the protocol derivation that
 * quietly diverges them fails here rather than as a user-visible fork-target
 * mismatch.
 */

const CONTENT: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

const ASSISTANT_SENDER: AgentSender = {
  type: "agent",
  harnessId: "claude",
  agentId: "claude-sonnet-4",
  displayName: "Claude Sonnet 4",
  reply: { expectsReply: false },
  inReplyTo: null,
};

const BINDING = {
  epicId: "epic-1",
  ownerId: "owner-1",
  ownerKind: "chat" as const,
  viewTabId: "tab-1",
};

function userMessage(
  messageId: string,
  timestamp: number,
): Extract<Message, { role: "user" }> {
  return {
    role: "user",
    messageId,
    sender: { type: "user", userId: "owner-1" },
    message: { kind: "user", content: CONTENT, browserAnnotations: [] },
    timestamp,
    sessionAnchor: null,
  };
}

function textBlock(
  blockId: string,
  timestamp: number,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "text",
    blockId,
    status: "completed",
    timestamp,
    text: "hi",
    providerNotice: null,
  };
}

function steerBlock(
  blockId: string,
  timestamp: number,
  messageId: string,
): Extract<Message, { role: "assistant" }>["blocks"][number] {
  return {
    type: "steer",
    blockId,
    status: "completed",
    timestamp,
    queueItemId: `q-${blockId}`,
    messageId,
    content: CONTENT,
    mode: "safe_point",
    sender: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string | null;
  blocks: Extract<Message, { role: "assistant" }>["blocks"];
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: ASSISTANT_SENDER,
    blocks: input.blocks,
    startedAt: input.timestamp,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: (_sender, reasoningEffort) =>
    reasoningEffort === null ? null : `Resolved ${reasoningEffort}`,
  contentBlocksPreview: () => "",
};

const CANONICAL_INPUT: RenderedMessagesInput = {
  messages: [],
  events: [],
  rowContext: {},
  pendingUserMessages: [],
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  setupCardWindows: [],
  ...BINDING,
};

function activeTurn(turnId: string): ChatActiveTurn {
  return {
    agentMode: "regular",
    sameTurnSteeringSupported: false,
    turnId,
    status: "running",
    harnessId: "claude",
    model: "claude-sonnet-4-5",
    profileId: null,
    userMessageId: null,
    startedAt: 1,
    updatedAt: 2,
    reasoningEffort: null,
    serviceTier: null,
  };
}

/**
 * Runs a fixture through BOTH the renderer's own scan and the protocol
 * derivation and returns both answers for comparison.
 *
 * The protocol side goes through `projectTranscriptRows` because that is what
 * the host feeds it (`chat-transcript-view.ts` → `chat-transcript-derived.ts`).
 * The two sides stay genuinely independent: the renderer never calls the
 * projection, it builds its own rows and sorts them itself.
 */
function bothForkBoundaries(input: Partial<RenderedMessagesInput>): {
  rendererResult: string | null;
  protocolResult: string | null;
} {
  const value: RenderedMessagesInput = { ...CANONICAL_INPUT, ...input };
  const { result } = renderHook(() =>
    useRenderedMessages(value, displayContext),
  );
  const activeTurnId = value.activeTurn?.turnId ?? null;
  const rows = projectTranscriptRows({
    messages: value.messages,
    events: value.events,
    activeTurnId,
    // `ownerKind` is "chat" throughout this fixture set, so the owner id IS
    // the chat id. It only reaches setup-card row ids, which no fixture here
    // produces - but passing the real one keeps the projection honest.
    chatId: value.ownerId,
  });
  return {
    rendererResult: rendererLatestForkableAssistantMessageId(result.current),
    protocolResult: protocolLatestForkableAssistantMessageId(
      rows,
      activeTurnId,
    ),
  };
}

describe("latestForkableAssistantMessageId renderer/protocol equivalence", () => {
  it("agree on an idle chat", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          blocks: [textBlock("b-1", 2000)],
        }),
      ],
    });

    expect(rendererResult).toBe("a-1");
    expect(protocolResult).toBe(rendererResult);
  });

  it("agree on a chat with an active turn - both skip it and fall back to the turn before", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-1",
          timestamp: 1000,
          turnId: "turn-1",
          blocks: [textBlock("b-1", 1000)],
        }),
        userMessage("u-1", 1500),
        assistantMessage({
          messageId: "a-2",
          timestamp: 2000,
          turnId: "turn-2",
          blocks: [textBlock("b-2", 2000)],
        }),
      ],
      activeTurn: activeTurn("turn-2"),
      runStatus: "running",
    });

    expect(rendererResult).toBe("a-1");
    expect(protocolResult).toBe(rendererResult);
  });

  it("agree on a multi-record turn - both use the last record's messageId", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-1-first",
          timestamp: 1000,
          turnId: "turn-1",
          blocks: [textBlock("b-1", 1000)],
        }),
        assistantMessage({
          messageId: "a-1-second",
          timestamp: 1500,
          turnId: "turn-1",
          blocks: [textBlock("b-2", 1500)],
        }),
      ],
    });

    expect(rendererResult).toBe("a-1-second");
    expect(protocolResult).toBe(rendererResult);
  });

  /*
   * The shapes that drove the two orders apart. `upsertEntry` appends an
   * unseen record at the array TAIL, so a checkpoint restore re-adds a record
   * whose display position is historical. Before the fork boundary read
   * projected rows these two disagreed: the protocol side scanned the record
   * array and answered `a-1-restored` for the first and, given the canonical
   * order its docstring asked for, `a-1-late` for the second.
   */

  it("agree when a restored record of an OLDER turn sits at the projection tail", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-1",
          timestamp: 1000,
          turnId: "turn-1",
          blocks: [textBlock("b-1", 1000)],
        }),
        assistantMessage({
          messageId: "a-2",
          timestamp: 2000,
          turnId: "turn-2",
          blocks: [textBlock("b-2", 2000)],
        }),
        assistantMessage({
          messageId: "a-1-restored",
          timestamp: 1100,
          turnId: "turn-1",
          blocks: [textBlock("b-3", 1100)],
        }),
      ],
    });

    expect(rendererResult).toBe("a-2");
    expect(protocolResult).toBe(rendererResult);
  });

  it("agree on the id when a restored sibling of the SAME turn is re-added after it", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-1-late",
          timestamp: 2000,
          turnId: "turn-1",
          blocks: [textBlock("b-1", 2000)],
        }),
        assistantMessage({
          messageId: "a-1-early",
          timestamp: 1000,
          turnId: "turn-1",
          blocks: [textBlock("b-2", 1000)],
        }),
      ],
    });

    expect(rendererResult).toBe("a-1-early");
    expect(protocolResult).toBe(rendererResult);
  });

  it("agree on legacy turnId: null records, each its own turn", () => {
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-legacy-1",
          timestamp: 1000,
          turnId: null,
          blocks: [textBlock("b-1", 1000)],
        }),
        assistantMessage({
          messageId: "a-legacy-2",
          timestamp: 2000,
          turnId: null,
          blocks: [textBlock("b-2", 2000)],
        }),
      ],
    });

    expect(rendererResult).toBe("a-legacy-2");
    expect(protocolResult).toBe(rendererResult);
  });

  it("agree on a STOPPED steer-only turn, whose boundary row is synthesized", () => {
    // The one turn shape that produces no assistant SLICE at all, so its
    // trailing row is numbered `part:0` rather than "one past the last slice"
    // (`row-projection.test.ts` pins that id string). Both sides read the same
    // `nextChunkIndex` to synthesize it, which is why the projection assertion
    // alone cannot catch renderer-side drift here and this half is needed too.
    const { rendererResult, protocolResult } = bothForkBoundaries({
      messages: [
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          blocks: [steerBlock("b-1", 2000, "u-gone")],
        }),
      ],
      events: [
        {
          eventId: "e-stop",
          type: "turn.stopped",
          timestamp: 2500,
          clientActionId: null,
          actor: null,
          message: null,
          turnId: "turn-1",
          messageId: null,
          queueItemId: null,
          approvalId: null,
          blockId: null,
          severity: "info",
          metadata: null,
        },
      ],
    });

    expect(rendererResult).toBe("a-1");
    expect(protocolResult).toBe(rendererResult);
  });
});
