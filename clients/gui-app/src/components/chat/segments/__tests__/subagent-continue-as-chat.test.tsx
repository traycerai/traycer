import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ContinueSubagentResponse } from "@traycer/protocol/host/epic/unary-schemas";

const mutate = vi.hoisted(() => vi.fn());
/** Opens and cancels in the order they happened, by chat id. */
const openLog = vi.hoisted((): string[] => []);
const cancels = vi.hoisted(() => ({ byChatId: new Map<string, () => void>() }));
const openCreatedChatWhenProjected = vi.hoisted(() => vi.fn());
const useHostSupportsMethod = vi.hoisted(() => vi.fn());
const mutationState = vi.hoisted(() => ({ isPending: false }));

vi.mock("@/hooks/epic/use-epic-continue-subagent-mutation", () => ({
  useEpicContinueSubagent: () => ({
    mutate,
    isPending: mutationState.isPending,
  }),
}));
vi.mock("@/lib/commands/actions/new-chat", () => ({
  openCreatedChatWhenProjected,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostSupportsMethod,
}));

import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { useSubagentContinueAsChat } from "@/components/chat/segments/subagent-continue-as-chat";
import type { SubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import type {
  ChatMessage as ChatMessageModel,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function settings(harnessId: ChatRunSettings["harnessId"]): ChatRunSettings {
  return {
    harnessId,
    model: "model-1",
    permissionMode: "supervised",
    reasoningEffort: null,
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
  };
}

function card(id: string, parentId: string | null): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name: `${id}-agent`,
    agentType: null,
    task: `${id} task`,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId,
    workflowMeta: null,
    children: [],
  };
}

function messagesOf(root: SubagentSegment): ReadonlyArray<ChatMessageModel> {
  return [{ ...makeMessage(1, "assistant"), segments: [root] }];
}

const close = vi.fn();

function drillIn(openId: string | null): SubagentDrillIn {
  return { openId, open: vi.fn(), close };
}

interface Overrides {
  readonly openId: string | null;
  readonly messages: ReadonlyArray<ChatMessageModel>;
  readonly settings: ChatRunSettings | null;
  readonly canAct: boolean;
  readonly isLiveSession: boolean;
}

function hookArgs(overrides: Partial<Overrides>) {
  const base: Overrides = {
    openId: "card-1",
    messages: messagesOf(card("card-1", null)),
    settings: settings("codex"),
    canAct: true,
    isLiveSession: true,
    ...overrides,
  };
  return {
    drillIn: drillIn(base.openId),
    messages: base.messages,
    epicId: "epic-1",
    chatId: "chat-1",
    hostId: "host-1",
    viewTabId: "tab-1",
    settings: base.settings,
    canAct: base.canAct,
    isLiveSession: base.isLiveSession,
  };
}

function render(overrides: Partial<Overrides>) {
  return renderHook(
    (props: Partial<Overrides>) => useSubagentContinueAsChat(hookArgs(props)),
    { initialProps: overrides },
  );
}

/** Makes the next `mutate` answer with `response`, as the hook's call site sees it. */
function answerWith(response: ContinueSubagentResponse): void {
  mutate.mockImplementation(
    (
      _variables: unknown,
      options: { onSuccess: (r: ContinueSubagentResponse) => void },
    ) => {
      options.onSuccess(response);
    },
  );
}

type AnswerCallback = (response: ContinueSubagentResponse) => void;

/** Makes `mutate` hold its `onSuccess` so the test delivers the answer later. */
function deferAnswer(): { deliver: AnswerCallback } {
  let pending: AnswerCallback | null = null;
  mutate.mockImplementation(
    (_variables: unknown, options: { onSuccess: AnswerCallback }) => {
      pending = options.onSuccess;
    },
  );
  return {
    deliver: (response) => {
      if (pending === null) throw new Error("no request was made");
      pending(response);
    },
  };
}

describe("useSubagentContinueAsChat", () => {
  beforeEach(() => {
    mutate.mockReset();
    openCreatedChatWhenProjected.mockReset();
    openLog.length = 0;
    cancels.byChatId.clear();
    openCreatedChatWhenProjected.mockImplementation(
      (intent: { chatId: string }) => {
        openLog.push(`open:${intent.chatId}`);
        const cancel = vi.fn(() => {
          openLog.push(`cancel:${intent.chatId}`);
        });
        cancels.byChatId.set(intent.chatId, cancel);
        return cancel;
      },
    );
    close.mockReset();
    useHostSupportsMethod.mockReset();
    useHostSupportsMethod.mockReturnValue(true);
    mutationState.isPending = false;
  });

  describe("offered", () => {
    it.each(["codex", "claude"] as const)(
      "is offered for a finished %s card",
      (harness) => {
        const { result } = render({ settings: settings(harness) });
        expect(result.current).not.toBeNull();
      },
    );

    it("asks the host support check about the verb for the given host", () => {
      render({});
      expect(useHostSupportsMethod).toHaveBeenCalledWith(
        "host-1",
        "epic.continueSubagent",
      );
    });
  });

  describe("which harness decides (the owning turn's provider, else settings)", () => {
    function turn(
      index: number,
      provider: ChatRunSettings["harnessId"] | null,
      segment: SubagentSegment,
    ): ChatMessageModel {
      return {
        ...makeMessage(index, "assistant"),
        segments: [segment],
        assistantMeta:
          provider === null
            ? null
            : {
                provider,
                providerLabel: provider,
                profileLabel: null,
                envCredentialVar: null,
                modelLabel: null,
                reasoningEffort: null,
                reasoningEffortLabel: null,
                serviceTier: null,
                costUsd: null,
              },
      };
    }

    it("offers a card whose turn ran on codex although settings now name opencode", () => {
      const messages = [turn(1, "codex", card("card-1", null))];
      const { result } = render({ messages, settings: settings("opencode") });
      expect(result.current).not.toBeNull();
    });

    it("refuses a card whose turn ran on opencode although settings now name claude", () => {
      const messages = [turn(1, "opencode", card("card-1", null))];
      const { result } = render({ messages, settings: settings("claude") });
      expect(result.current).toBeNull();
    });

    it("falls back to settings when the turn recorded no provider", () => {
      const messages = [turn(1, null, card("card-1", null))];
      expect(
        render({ messages, settings: settings("claude") }).result.current,
      ).not.toBeNull();
      expect(render({ messages, settings: null }).result.current).toBeNull();
    });

    it("judges each card by its OWN turn's provider", () => {
      const messages = [
        turn(1, "codex", card("card-1", null)),
        turn(2, "opencode", card("card-2", null)),
      ];
      const settingsNow = settings("claude");
      expect(
        render({ messages, openId: "card-1", settings: settingsNow }).result
          .current,
      ).not.toBeNull();
      expect(
        render({ messages, openId: "card-2", settings: settingsNow }).result
          .current,
      ).toBeNull();
    });
  });

  describe("not offered", () => {
    it("with no card open", () => {
      expect(render({ openId: null }).result.current).toBeNull();
    });

    it("for a harness whose subagents cannot be continued", () => {
      expect(
        render({ settings: settings("opencode") }).result.current,
      ).toBeNull();
    });

    it("before the chat has run settings", () => {
      expect(render({ settings: null }).result.current).toBeNull();
    });

    it("to a reader who cannot act", () => {
      expect(render({ canAct: false }).result.current).toBeNull();
    });

    it("on a tile that is not the live session", () => {
      expect(render({ isLiveSession: false }).result.current).toBeNull();
    });

    it("on a host without the verb", () => {
      useHostSupportsMethod.mockReturnValue(false);
      expect(render({}).result.current).toBeNull();
    });

    it("for a workflow card", () => {
      const workflow: SubagentSegment = {
        ...card("card-1", null),
        workflowMeta: {
          name: "review",
          intent: "Review the changeset",
          activity: [],
          agentsStarted: 2,
          agentsFinished: 1,
          totalTokens: 1000,
        },
      };
      expect(
        render({ messages: messagesOf(workflow) }).result.current,
      ).toBeNull();
    });

    it("when the open id names a card that is no longer in the transcript", () => {
      expect(render({ openId: "gone" }).result.current).toBeNull();
    });
  });

  describe("run", () => {
    it("continues the open card by its own block id", () => {
      const { result } = render({});
      result.current?.run();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "card-1",
      });
    });

    it("sends a nested card's own id, not its ancestor's", () => {
      const root: SubagentSegment = {
        ...card("root", null),
        children: [card("leaf", "root")],
      };
      const { result } = render({
        openId: "leaf",
        messages: messagesOf(root),
      });
      result.current?.run();
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "leaf",
      });
    });

    it.each(["created", "existing"] as const)(
      "opens the returned chat once projected and closes the view on %s",
      (kind) => {
        answerWith({ kind, epicId: "epic-answer", chatId: "chat-new" });
        const { result } = render({});
        result.current?.run();
        expect(openCreatedChatWhenProjected).toHaveBeenCalledTimes(1);
        // The RESPONSE's epic and chat, not the hook's own (`epic-1`, `chat-1`).
        expect(openCreatedChatWhenProjected).toHaveBeenCalledWith({
          epicId: "epic-answer",
          tabId: "tab-1",
          chatId: "chat-new",
          hostId: "host-1",
          placement: null,
          source: "direct_ui",
        });
        expect(close).toHaveBeenCalledTimes(1);
      },
    );

    describe("the pending open", () => {
      const created = (chatId: string): ContinueSubagentResponse => ({
        kind: "created",
        epicId: "epic-1",
        chatId,
      });

      it("is cancelled once when the hook unmounts after an answer", () => {
        answerWith(created("chat-a"));
        const { result, unmount } = render({});
        result.current?.run();
        expect(cancels.byChatId.get("chat-a")).not.toHaveBeenCalled();
        unmount();
        expect(cancels.byChatId.get("chat-a")).toHaveBeenCalledTimes(1);
      });

      it("has nothing to cancel when the hook unmounts before an answer", () => {
        deferAnswer();
        const { result, unmount } = render({});
        result.current?.run();
        unmount();
        expect(openCreatedChatWhenProjected).not.toHaveBeenCalled();
        expect(openLog).toEqual([]);
      });

      it("cancels the first wait before the second answer's open starts", () => {
        const { result, unmount } = render({});
        answerWith(created("chat-a"));
        result.current?.run();
        answerWith(created("chat-b"));
        result.current?.run();
        expect(openLog).toEqual([
          "open:chat-a",
          "cancel:chat-a",
          "open:chat-b",
        ]);
        expect(cancels.byChatId.get("chat-b")).not.toHaveBeenCalled();
        unmount();
        expect(openLog).toEqual([
          "open:chat-a",
          "cancel:chat-a",
          "open:chat-b",
          "cancel:chat-b",
        ]);
        expect(cancels.byChatId.get("chat-a")).toHaveBeenCalledTimes(1);
      });
    });

    describe("when the answer arrives after the reader moved", () => {
      const twoCards = (): ReadonlyArray<ChatMessageModel> =>
        messagesOf({
          ...card("card-1", null),
          children: [],
        }).concat(messagesOf(card("card-2", null)));

      it("still requests the open but keeps another card's view open", () => {
        const answer = deferAnswer();
        const messages = twoCards();
        const { result, rerender } = render({ openId: "card-1", messages });
        result.current?.run();
        rerender({ openId: "card-2", messages });
        answer.deliver({ kind: "created", epicId: "epic-1", chatId: "chat-a" });
        expect(openCreatedChatWhenProjected).toHaveBeenCalledTimes(1);
        expect(openCreatedChatWhenProjected).toHaveBeenCalledWith(
          expect.objectContaining({ chatId: "chat-a" }),
        );
        expect(close).not.toHaveBeenCalled();
      });

      it("still requests the open but does not close once the reader is back on the chat", () => {
        const answer = deferAnswer();
        const { result, rerender } = render({ openId: "card-1" });
        result.current?.run();
        rerender({ openId: null });
        answer.deliver({ kind: "created", epicId: "epic-1", chatId: "chat-a" });
        expect(openCreatedChatWhenProjected).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
      });

      it("still closes when the same card stays open across a streamed update", () => {
        const answer = deferAnswer();
        const { result, rerender } = render({ openId: "card-1" });
        result.current?.run();
        rerender({
          openId: "card-1",
          messages: messagesOf(card("card-1", null)),
        });
        answer.deliver({
          kind: "existing",
          epicId: "epic-1",
          chatId: "chat-a",
        });
        expect(openCreatedChatWhenProjected).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
      });
    });

    it("opens nothing and leaves the view open on a refusal", () => {
      answerWith({
        kind: "refused",
        reason: "still_running",
        detail: "",
      });
      const { result } = render({});
      result.current?.run();
      expect(mutate).toHaveBeenCalledTimes(1);
      expect(openCreatedChatWhenProjected).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe("isPending", () => {
    it("is false for an idle request and a finished card", () => {
      expect(render({}).result.current?.isPending).toBe(false);
    });

    it("is true while the request is in flight", () => {
      mutationState.isPending = true;
      expect(render({}).result.current?.isPending).toBe(true);
    });

    it("is true while the card is still streaming, with no request in flight", () => {
      const streaming: SubagentSegment = {
        ...card("card-1", null),
        isStreaming: true,
      };
      expect(
        render({ messages: messagesOf(streaming) }).result.current?.isPending,
      ).toBe(true);
    });
  });
});
