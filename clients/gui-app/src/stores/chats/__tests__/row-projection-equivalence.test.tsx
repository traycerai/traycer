import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ChatEvent,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import type { ChatActiveTurn } from "@traycer/protocol/host/agent/gui/subscribe";
import { projectTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";

/**
 * # The acceptance bar for the row projection
 *
 * The host numbers a row's ORDINAL as its index in
 * `projectTranscriptRows(...)`. The renderer draws rows from
 * `useRenderedMessages(...)`. If those two enumerations ever disagree by one
 * row, the client renders bodies under the wrong rows for the rest of the
 * transcript - and nothing about that failure is loud. It looks like a chat
 * whose messages are subtly shuffled.
 *
 * So this is the test that actually pins the claim: every other test in this
 * feature checks a RULE, and only this one checks that the two implementations
 * of all the rules together land on the same list. It drives the real hook -
 * no re-implementation, no shared fixture builder that could be wrong in the
 * same direction twice.
 *
 * ## Why the comparison filters
 *
 * The projection enumerates DURABLE rows. Three of the renderer's sources are
 * client-only (the optimistic pending echo, the live assistant row, the
 * pre-turn indicator) and carry no ordinal, because all three sort into the
 * pinned-hydrated tail. Fixtures here therefore leave those inputs empty, so
 * the comparison is exact rather than filtered - with one deliberate exception
 * documented on the active-turn case.
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

type AssistantMessage = Extract<Message, { role: "assistant" }>;
type ContentBlock = AssistantMessage["blocks"][number];

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

function textBlock(blockId: string, timestamp: number): ContentBlock {
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
): ContentBlock {
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
  startedAt: number | null;
  blocks: ReadonlyArray<ContentBlock>;
}): AssistantMessage {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: ASSISTANT_SENDER,
    blocks: [...input.blocks],
    startedAt: input.startedAt,
    timestamp: input.timestamp,
    turnId: input.turnId,
    usage: null,
    reasoningEffort: null,
    serviceTier: null,
    imageResolutions: [],
  };
}

function event(input: {
  eventId: string;
  type: ChatEvent["type"];
  timestamp: number;
  turnId?: string | null;
  messageId?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}): ChatEvent {
  return {
    eventId: input.eventId,
    type: input.type,
    timestamp: input.timestamp,
    clientActionId: null,
    actor: null,
    message: input.message ?? null,
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    queueItemId: null,
    approvalId: null,
    blockId: null,
    severity: "info",
    metadata: input.metadata ?? null,
  };
}

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

const displayContext: RenderedMessagesDisplayContext = {
  resolveUserSenderLabel: () => "You",
  resolveAgentSenderDisplay: () => ({
    senderLabel: "Claude",
    providerLabel: "Claude Code",
    modelLabel: null,
  }),
  resolveAgentReasoningLabel: () => null,
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

interface BothEnumerations {
  readonly rendered: readonly string[];
  readonly projected: readonly string[];
}

function bothEnumerations(
  input: Partial<RenderedMessagesInput>,
): BothEnumerations {
  const value: RenderedMessagesInput = { ...CANONICAL_INPUT, ...input };
  const { result } = renderHook(() =>
    useRenderedMessages(value, displayContext),
  );
  return {
    rendered: result.current.map((row) => row.id),
    projected: projectTranscriptRows({
      messages: value.messages,
      events: value.events,
      activeTurnId: value.activeTurn?.turnId ?? null,
      chatId: value.ownerId,
    }).map((row) => row.rowId),
  };
}

/** Asserts the two enumerations are identical, id for id, in order. */
function expectSameRows(input: Partial<RenderedMessagesInput>): void {
  const { rendered, projected } = bothEnumerations(input);
  expect(projected).toEqual(rendered);
}

describe("row projection / renderer equivalence", () => {
  it("agrees on an empty chat", () => {
    expectSameRows({});
  });

  it("agrees on a plain user/assistant exchange", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [textBlock("b-1", 1600)],
        }),
      ],
    });
  });

  it("agrees on a multi-record turn with no steer - three records, one row", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        ...[1, 2, 3].map((n) =>
          assistantMessage({
            messageId: `a-${n}`,
            timestamp: 2000 + n,
            turnId: "turn-1",
            startedAt: 1500,
            blocks: [textBlock(`b-${n}`, 1600 + n)],
          }),
        ),
      ],
    });
  });

  it("agrees on a steer-split turn, including the suppressed top-level user row", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        userMessage("u-steer", 1800),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [
            textBlock("b-1", 1600),
            steerBlock("b-2", 1800, "u-steer"),
            textBlock("b-3", 1900),
          ],
        }),
      ],
    });
  });

  it("agrees on a turn whose blocks are ALL steers", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        userMessage("u-steer", 1800),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [steerBlock("b-1", 1800, "u-steer")],
        }),
      ],
    });
  });

  it("agrees on an ORPHANED steer block, whose row is identified by its queue item", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [
            textBlock("b-1", 1600),
            // No `u-gone` record: a checkpoint rewrote the block and the row
            // was written once.
            steerBlock("b-2", 1800, "u-gone"),
          ],
        }),
      ],
    });
  });

  it("agrees on a STOPPED turn ending on a steer - the synthesized boundary row", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [textBlock("b-1", 1600), steerBlock("b-2", 1800, "u-gone")],
        }),
      ],
      events: [
        event({
          eventId: "e-stop",
          type: "turn.stopped",
          timestamp: 2100,
          turnId: "turn-1",
          message: "Stop requested by owner.",
        }),
      ],
    });
  });

  it("agrees on a Stop that landed before any assistant record", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000)],
      events: [
        event({
          eventId: "e-stop",
          type: "turn.stopped",
          timestamp: 1500,
          turnId: "turn-1",
          messageId: "u-1",
          message: "Stop requested by owner.",
        }),
      ],
    });
  });

  it("agrees when a pre-turn Stop names a message that was branched away", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000)],
      events: [
        event({
          eventId: "e-stop",
          type: "turn.stopped",
          timestamp: 1500,
          turnId: "turn-1",
          messageId: "u-branched-away",
          message: "Stop requested by owner.",
        }),
      ],
    });
  });

  it("agrees on a LEGACY record with null startedAt, which anchors on the last user send", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          // `timestamp` is rewritten per streaming delta; the row must not
          // move to the tail because of it.
          timestamp: 9_000,
          turnId: "turn-1",
          startedAt: null,
          blocks: [textBlock("b-1", 1600)],
        }),
        userMessage("u-2", 2000),
      ],
    });
  });

  it("agrees on a checkpoint-restore re-append - a re-added record at the array tail", () => {
    const restored = userMessage("u-restored", 1000);
    expectSameRows({
      messages: [
        userMessage("u-1", 500),
        assistantMessage({
          messageId: "a-1",
          timestamp: 3000,
          turnId: "turn-1",
          startedAt: 2000,
          blocks: [textBlock("b-1", 2100)],
        }),
        // Re-added at the tail by `upsertEntry` while its timestamp still
        // places it near the top.
        restored,
      ],
    });
  });

  it("agrees on a genesis setup card, which pins above an earlier message", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000)],
      events: [
        // No `setup.creating`: back-filled genesis, stamped LATE.
        event({
          eventId: "e-setup",
          type: "setup.running",
          timestamp: 5000,
          metadata: { workspacePath: "/w" },
        }),
      ],
    });
  });

  it("agrees on a mid-chat setup card woven above its triggering message", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000), userMessage("u-2", 3000)],
      events: [
        event({
          eventId: "e-create",
          type: "setup.creating",
          timestamp: 2000,
          metadata: { workspacePath: "/w", triggeringMessageId: "u-2" },
        }),
        event({
          eventId: "e-run",
          type: "setup.running",
          timestamp: 2100,
          metadata: { workspacePath: "/w" },
        }),
      ],
    });
  });

  it("agrees on a setup card whose anchor was branched away, so it floats", () => {
    expectSameRows({
      messages: [userMessage("u-2", 3000)],
      events: [
        event({
          eventId: "e-create",
          type: "setup.creating",
          timestamp: 2000,
          metadata: { workspacePath: "/w", triggeringMessageId: "u-gone" },
        }),
      ],
    });
  });

  it("agrees on TWO setup lifecycles split by worktree.missing", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000), userMessage("u-2", 4000)],
      events: [
        event({
          eventId: "e-run-1",
          type: "setup.running",
          timestamp: 900,
          metadata: { workspacePath: "/w" },
        }),
        event({
          eventId: "e-ok-1",
          type: "setup.succeeded",
          timestamp: 950,
          metadata: { workspacePath: "/w" },
        }),
        event({
          eventId: "e-missing",
          type: "worktree.missing",
          timestamp: 3000,
        }),
        event({
          eventId: "e-run-2",
          type: "setup.running",
          timestamp: 3500,
          metadata: { workspacePath: "/w2" },
        }),
      ],
    });
  });

  it("agrees on fork-link and notification-anchor rows at the SAME timestamp, in both input orders", () => {
    const fork = event({
      eventId: "e-fork",
      type: "chat.forked",
      timestamp: 2000,
      metadata: { sourceChatId: "c-src", sourceHostId: "h-src" },
    });
    const anchor = event({
      eventId: "e-anchor",
      type: "send.failed",
      timestamp: 2000,
      message: "boom",
      metadata: { notificationAnchor: true },
    });
    const messages = [userMessage("u-1", 1000)];

    // The renderer buckets ALL fork links before ALL notification anchors, so
    // the tie resolves the same way whichever order the event log holds them
    // in. A projection that preserved event order would disagree with one of
    // these two.
    expectSameRows({ messages, events: [fork, anchor] });
    expectSameRows({ messages, events: [anchor, fork] });
  });

  it("agrees on an event whose metadata is present but EMPTY, which draws no row", () => {
    expectSameRows({
      messages: [userMessage("u-1", 1000)],
      events: [
        event({
          eventId: "e-fork",
          type: "chat.forked",
          timestamp: 2000,
          metadata: { sourceChatId: "", sourceHostId: "h-src" },
        }),
      ],
    });
  });

  it("agrees on a chat mixing every durable row source at once", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        userMessage("u-steer", 1800),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [
            textBlock("b-1", 1600),
            steerBlock("b-2", 1800, "u-steer"),
            textBlock("b-3", 1900),
          ],
        }),
        userMessage("u-2", 3000),
        assistantMessage({
          messageId: "a-2",
          timestamp: 4000,
          turnId: "turn-2",
          startedAt: 3500,
          blocks: [textBlock("b-4", 3600), steerBlock("b-5", 3700, "u-gone")],
        }),
      ],
      events: [
        event({
          eventId: "e-setup",
          type: "setup.creating",
          timestamp: 2900,
          metadata: { workspacePath: "/w", triggeringMessageId: "u-2" },
        }),
        event({
          eventId: "e-fork",
          type: "chat.forked",
          timestamp: 2500,
          metadata: { sourceChatId: "c-src", sourceHostId: "h-src" },
        }),
        event({
          eventId: "e-anchor",
          type: "send.failed",
          timestamp: 4500,
          message: "boom",
          metadata: { notificationAnchor: true },
        }),
        event({
          eventId: "e-stop",
          type: "turn.stopped",
          timestamp: 4100,
          turnId: "turn-2",
          message: "Stop requested by owner.",
        }),
      ],
    });
  });
});

describe("an ACTIVE turn - the one place the two deliberately differ", () => {
  it("projects a PREFIX of the rendered rows, missing only the live indicator", () => {
    // The projection models `runState` as absent, so a live turn's trailing
    // indicator row is the renderer's alone. It is a client-only row in the
    // pinned-hydrated tail and carries no ordinal - see the module doc.
    const { rendered, projected } = bothEnumerations({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          blocks: [textBlock("b-1", 1600), steerBlock("b-2", 1800, "u-gone")],
        }),
      ],
      activeTurn: activeTurn("turn-1"),
      runStatus: "running",
    });

    expect(rendered.slice(0, projected.length)).toEqual(projected);
    // Exactly one extra row, and it belongs to the active turn. Named
    // EXACTLY, not by `toContain`: `assistant:turn-1` is a prefix of
    // `assistant:turn-1:part:1`, so a substring match cannot tell the pre-turn
    // indicator (`renderPendingRunIndicator`) from the trailing synthesized
    // slice (`attachRunStateToTrailingAssistantSlice`) - two different
    // client-only row sources, in a suite whose whole point is exact
    // enumeration agreement. This fixture ends on a steer with a live run
    // state, so the extra row is the trailing slice.
    expect(rendered).toHaveLength(projected.length + 1);
    expect(rendered.at(-1)).toBe("assistant:turn-1:part:1");
  });

  it("agrees exactly when a turn is active but produces no trailing indicator row", () => {
    expectSameRows({
      messages: [
        userMessage("u-1", 1000),
        assistantMessage({
          messageId: "a-1",
          timestamp: 2000,
          turnId: "turn-1",
          startedAt: 1500,
          // Ends on an assistant slice, so the run state attaches in place
          // rather than adding a row.
          blocks: [textBlock("b-1", 1600)],
        }),
      ],
      activeTurn: activeTurn("turn-1"),
      runStatus: "running",
    });
  });
});
