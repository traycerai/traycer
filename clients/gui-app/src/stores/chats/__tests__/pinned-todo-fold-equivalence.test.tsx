import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  AgentSender,
  ContentBlock,
  Message,
} from "@traycer/protocol/persistence/epic/schemas";
import { projectTranscriptRows } from "@traycer/protocol/persistence/chat-transcript/row-projection";
import { buildPinnedTodoRenderState } from "@/components/chat/chat-pinned-todos";
import {
  useRenderedMessages,
  type RenderedMessagesDisplayContext,
  type RenderedMessagesInput,
} from "@/stores/chats/rendered-messages";
// The shared half of the fold, from protocol. It used to be a cross-repo
// relative path into `traycer-host/`, which resolves only in the internal
// monorepo - so this corpus was silently unrunnable in a standalone OSS clone,
// i.e. exactly where it needs to run. `foldPinnedTodo`/`contentBlocksById` are
// host-owned (`traycer-host/`, a sibling checkout of this submodule, not a
// package `traycer/` itself depends on). This is the one place that boundary
// is crossed - see the module doc below for why.
import {
  contentBlocksById,
  foldPinnedTodo,
} from "@traycer/protocol/persistence/chat-transcript/pinned-todo-fold";

/**
 * # Pinned-todo fold: renderer/host equivalence
 *
 * `foldPinnedTodo` (`traycer-host/src/domain/chat/chat-pinned-todo-fold.ts`) is
 * a HAND-PORTED mirror of this renderer's `derivePinnedTodo`
 * (`chat-pinned-todos.ts`), not a call into shared `@traycer/protocol` code the
 * way `latestForkableAssistantMessageId` is (see `fork-boundary-equivalence.test.tsx`,
 * whose shape this file otherwise follows) - the host module's own doc comment
 * says as much: "when the segmentization extraction lands, this module should
 * be deleted and both sides should call the moved fold. Until then a change to
 * the renderer's fold has to be mirrored here."
 *
 * `traycer-host/` and `traycer/` are separate git repositories in normal
 * operation - this test crosses that boundary deliberately (the import above),
 * on the strength of the fact that both checkouts share one filesystem tree in
 * this internal-repo build and `chat-pinned-todo-fold.ts` itself imports only
 * `@traycer/protocol` types/helpers, no host-only (Node/SQLite/etc.) code. This
 * is a stopgap, not a pattern: it only works while a developer has BOTH repos
 * checked out side by side, and it would need the actual shared-derivation
 * extraction (the fold moving into `@traycer/protocol`) to be something a
 * standalone `traycer/` clone can run in CI. Do not extend this pattern to
 * other modules without that extraction landing first.
 *
 * Each case below runs one fixture through BOTH the renderer's REAL projection
 * (`useRenderedMessages` -> `planAssistantTurnRows` -> steer-row splitting ->
 * `buildPinnedTodoRenderState`) and the host's REAL `foldPinnedTodo` over
 * `projectTranscriptRows`'s output, and asserts they agree - the same shape as
 * `fork-boundary-equivalence.test.tsx`, just crossing a repo boundary that one
 * function doesn't have to.
 *
 * The steer-row case is the one worth pinning here specifically: it settles
 * (with real code, not by inspection) that a steer block splits into its own
 * `role: "user"` row rather than nesting inside the assistant row's segments -
 * see `renderSteerBlockUserMessage` / `renderAssistantTurnRows` in
 * `rendered-messages.ts`. The host's `foldPinnedTodo` relies on exactly that:
 * it treats `source.kind === "steer"` as arming the reset rule the same way a
 * top-level user row does.
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
    message: { kind: "user", content: CONTENT },
    timestamp,
    sessionAnchor: null,
  };
}

function taskCreateBlock(
  blockId: string,
  timestamp: number,
  text: string,
): ContentBlock {
  return {
    blockId,
    type: "tool_call",
    status: "completed",
    timestamp,
    toolName: "TaskCreate",
    inputSummary: null,
    inputDetail: null,
    taskTodoItems: [
      {
        id: null,
        text,
        status: null,
        priority: null,
        activeForm: null,
        action: "create",
      },
    ],
    error: null,
    agentMessageSend: null,
    managedCommand: null,
    progress: null,
    backgroundOutput: null,
    startedAt: null,
    endedAt: null,
    backgroundTask: false,
    stopped: false,
    imageResults: [],
  };
}

function steerBlock(
  blockId: string,
  timestamp: number,
  queueItemId: string,
): ContentBlock {
  return {
    blockId,
    type: "steer",
    status: "completed",
    timestamp,
    queueItemId,
    messageId: `steered:${queueItemId}`,
    content: CONTENT,
    mode: "safe_point",
    sender: null,
  };
}

function assistantMessage(input: {
  messageId: string;
  timestamp: number;
  turnId: string;
  blocks: readonly ContentBlock[];
}): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    messageId: input.messageId,
    sender: ASSISTANT_SENDER,
    // Copied rather than aliased: `AssistantMessage.blocks` is mutable, and a
    // `readonly` parameter cannot widen into it.
    blocks: [...input.blocks],
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
  pendingUserMessages: [],
  liveAssistantMessage: null,
  activeTurn: null,
  runStatus: "idle",
  ...BINDING,
};

function rendererPinnedTodoTexts(input: RenderedMessagesInput): string[] {
  const { result } = renderHook(() =>
    useRenderedMessages(input, displayContext),
  );
  const state = buildPinnedTodoRenderState(result.current, {
    kind: "derive",
  });
  return (state.todo?.items ?? []).map((item) => item.text);
}

/** Runs the REAL host fold over the same raw records, for direct comparison. */
function hostPinnedTodoTexts(input: RenderedMessagesInput): string[] {
  const rows = projectTranscriptRows({
    messages: input.messages,
    events: input.events,
    activeTurnId: input.activeTurn?.turnId ?? null,
    chatId: input.epicId,
  });
  const todo = foldPinnedTodo(rows, contentBlocksById(input.messages));
  return (todo?.items ?? []).map((item) => item.text);
}

/**
 * Runs one fixture through BOTH the renderer's real projection and the
 * host's real fold and returns both answers for comparison.
 */
function bothPinnedTodoTexts(input: Partial<RenderedMessagesInput>): {
  rendererTexts: string[];
  hostTexts: string[];
} {
  const value: RenderedMessagesInput = { ...CANONICAL_INPUT, ...input };
  return {
    rendererTexts: rendererPinnedTodoTexts(value),
    hostTexts: hostPinnedTodoTexts(value),
  };
}

describe("pinned-todo fold: renderer/host equivalence (real code, both sides)", () => {
  it("accumulates task-todo items across turns", () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [taskCreateBlock("task-create-1", 10, "First")],
        }),
        assistantMessage({
          messageId: "a2",
          timestamp: 20,
          turnId: "t2",
          blocks: [taskCreateBlock("task-create-2", 20, "Second")],
        }),
      ],
    });
    expect(rendererTexts).toEqual(["First", "Second"]);
    expect(hostTexts).toEqual(rendererTexts);
  });

  it("resets the accumulated task items on the first create after a user row", () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [taskCreateBlock("task-create-old", 10, "Old task")],
        }),
        userMessage("u2", 15),
        assistantMessage({
          messageId: "a2",
          timestamp: 20,
          turnId: "t2",
          blocks: [taskCreateBlock("task-create-new", 20, "New task")],
        }),
      ],
    });
    expect(rendererTexts).toEqual(["New task"]);
    expect(hostTexts).toEqual(rendererTexts);
  });

  it('resets the accumulated task items on a steer row too - THE case the host\'s `|| source.kind === "steer"` branch exists for', () => {
    const { rendererTexts, hostTexts } = bothPinnedTodoTexts({
      messages: [
        assistantMessage({
          messageId: "a1",
          timestamp: 10,
          turnId: "t1",
          blocks: [
            taskCreateBlock("task-create-old", 10, "Old task"),
            steerBlock("steer-1", 15, "queue-1"),
            taskCreateBlock("task-create-new", 20, "New task"),
          ],
        }),
      ],
    });
    // A steer block splits the turn into its own `role: "user"` row on the
    // renderer side (`renderAssistantTurnRows` / `renderSteerBlockUserMessage`)
    // and into its own `kind: "steer"` row on the host side
    // (`row-projection.ts`) - if either treated it as nested inside the
    // assistant row instead, the reset would never arm and this would read
    // ["Old task", "New task"].
    expect(rendererTexts).toEqual(["New task"]);
    expect(hostTexts).toEqual(rendererTexts);
  });
});
