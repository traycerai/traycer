import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  feedbackDraftRefusalMessage,
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
} from "../use-chat-feedback-draft";

describe("feedbackDraftRefusalMessage", () => {
  it("says nothing for a settled decision", () => {
    expect(
      feedbackDraftRefusalMessage({
        kind: "settled",
        feedbackDraft: { state: "skipped" } as never,
      }),
    ).toBeNull();
  });

  it("says nothing for already-decided, whose stamp the card shows", () => {
    expect(
      feedbackDraftRefusalMessage({
        kind: "error",
        code: "already-decided",
        feedbackDraft: { state: "sent" } as never,
      }),
    ).toBeNull();
  });

  it.each(["not-allowed", "session-unavailable", "not-draft-block"] as const)(
    "tells the user nothing was sent on %s",
    (code) => {
      expect(
        feedbackDraftRefusalMessage({
          kind: "error",
          code,
          feedbackDraft: null,
        }),
      ).toMatch(/^Nothing was sent/);
    },
  );
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const STAMP = {
  category: "tool-bug",
  toolName: null,
  goal: "Read a file",
  observed: "It failed",
  suggestion: null,
  suggestDiagnostics: false,
  decidedAt: null,
  failureReason: null,
} as const;

describe("feedback draft decision state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a sent decision after its card unmounts and the default gc window passes", async () => {
    vi.useFakeTimers();
    const settled: ChatFeedbackDraftDecideResponse = {
      kind: "settled",
      feedbackDraft: { ...STAMP, state: "sent", decidedAt: 6_000 },
    };
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const spine = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(new QueryClient()),
      messenger: new MockHostMessenger<HostRpcRegistry>({
        registry: hostRpcRegistry,
        requestId: () => "request-1",
        handlers: { "chat.feedbackDraft.decide": () => settled },
      }),
      findHostById: () => mockLocalHostEntry,
    });
    spine.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "token" }),
    );
    const client = spine.createRequester(mockLocalHostEntry);

    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(client, "block-1"),
      { wrapper },
    );
    const decided = card.result.current.mutateAsync({
      epicId: "epic-1",
      chatId: "chat-1",
      blockId: "block-1",
      decision: "send",
      includeDiagnostics: false,
      clientActionId: "action-1",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await expect(decided).resolves.toEqual(settled);
    expect(card.result.current.isSuccess).toBe(true);
    card.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    });

    const row = renderHook(() => useChatFeedbackDraftDecisionState("block-1"), {
      wrapper,
    });
    expect(row.result.current.response).toEqual(settled);
  });
});
