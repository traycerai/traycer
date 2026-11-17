import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useFeedbackDraftDecisionStore } from "@/stores/chats/feedback-draft-decision-store";
import {
  feedbackDraftRefusalMessage,
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
  useRetireFeedbackDraftDecision,
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

const SENT: ChatFeedbackDraftDecideResponse = {
  kind: "settled",
  feedbackDraft: { ...STAMP, state: "sent", decidedAt: 6_000 },
};

const DRAFT = {
  hostId: mockLocalHostEntry.hostId,
  epicId: "epic-1",
  chatId: "chat-1",
  blockId: "block-1",
};

const DECIDE_REQUEST = {
  epicId: "epic-1",
  chatId: "chat-1",
  blockId: "block-1",
  decision: "send",
  includeDiagnostics: false,
  clientActionId: "action-1",
} as const;

const GC_WINDOW_MS = 6 * 60 * 1000;

/** A new context object each call: the host client mints one per identity change, so a return to the same account is a new session. */
function contextFor(user: "a" | "b"): RequestContext {
  return createRequestContextFixture({
    origin: "renderer",
    bearerToken: `token-${user}`,
    identity: { userId: `user-${user}`, username: user, providerHandle: null },
  });
}

interface Harness {
  readonly spine: HostClient<HostRpcRegistry>;
  readonly client: HostRequester<HostRpcRegistry>;
  readonly wrapper: (props: { children: ReactNode }) => ReactNode;
}

function buildHarness(
  decide: () =>
    | ChatFeedbackDraftDecideResponse
    | Promise<ChatFeedbackDraftDecideResponse>,
): Harness {
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: { "chat.feedbackDraft.decide": decide },
    }),
    findHostById: () => mockLocalHostEntry,
  });
  spine.setRequestContext(contextFor("a"));
  return {
    spine,
    client: spine.createRequester(mockLocalHostEntry),
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function switchIdentity(
  spine: HostClient<HostRpcRegistry>,
  context: RequestContext,
): Promise<void> {
  await act(async () => {
    spine.setRequestContext(context);
    await vi.advanceTimersByTimeAsync(1_000);
  });
}

/** Decides the draft from a card that then unmounts, and lets the mutation be collected. */
async function decideFromClosedCard(harness: Harness): Promise<void> {
  const card = renderHook(
    () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
    { wrapper: harness.wrapper },
  );
  const decided = card.result.current.mutateAsync(DECIDE_REQUEST);
  await advance(1_000);
  await expect(decided).resolves.toEqual(SENT);
  card.unmount();
  await advance(GC_WINDOW_MS);
}

/** A reader of the draft's decision state, as its notification row mounts one. */
function mountReader(harness: Harness) {
  return renderHook(
    () => useChatFeedbackDraftDecisionState(harness.client, DRAFT),
    { wrapper: harness.wrapper },
  );
}

/** A decision whose answer the test delivers by hand. */
function heldDecision(): {
  readonly handler: () => Promise<ChatFeedbackDraftDecideResponse>;
  readonly answer: (response: ChatFeedbackDraftDecideResponse) => void;
} {
  let answer: (response: ChatFeedbackDraftDecideResponse) => void = () => {};
  return {
    handler: () =>
      new Promise<ChatFeedbackDraftDecideResponse>((resolve) => {
        answer = resolve;
      }),
    answer: (response) => {
      answer(response);
    },
  };
}

describe("feedback draft decision state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useFeedbackDraftDecisionStore.setState({
      sessionId: null,
      decisions: new Map(),
      resolved: new Set(),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a sent decision after its card unmounts and the default gc window passes", async () => {
    const harness = buildHarness(() => SENT);
    await decideFromClosedCard(harness);

    const row = mountReader(harness);
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);
  });

  it("drops the held decision once the draft's row has resolved", async () => {
    const harness = buildHarness(() => SENT);
    await decideFromClosedCard(harness);
    const row = mountReader(harness);
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);

    renderHook(
      () => useRetireFeedbackDraftDecision(harness.client, DRAFT, true),
      { wrapper: harness.wrapper },
    );

    expect(row.result.current.settled).toBeNull();
  });

  it("never shows a held decision to the account that returns after another, once the mutation is collected", async () => {
    const harness = buildHarness(() => SENT);
    await decideFromClosedCard(harness);
    const row = mountReader(harness);
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);

    await switchIdentity(harness.spine, contextFor("b"));
    expect(row.result.current.settled).toBeNull();

    await switchIdentity(harness.spine, contextFor("a"));
    expect(row.result.current.settled).toBeNull();
  });

  it("shows nothing to the account that returns after another while no reader was mounted", async () => {
    const harness = buildHarness(() => SENT);
    await decideFromClosedCard(harness);

    await switchIdentity(harness.spine, contextFor("b"));
    await switchIdentity(harness.spine, contextFor("a"));

    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
  });

  it("shows nothing to a returning account while the earlier session's mutation is still cached", async () => {
    const harness = buildHarness(() => SENT);
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
      { wrapper: harness.wrapper },
    );
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST);
    await advance(1_000);
    await expect(decided).resolves.toEqual(SENT);
    card.unmount();
    const row = mountReader(harness);
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);

    await switchIdentity(harness.spine, contextFor("b"));
    expect(row.result.current.settled).toBeNull();

    await switchIdentity(harness.spine, contextFor("a"));
    expect(row.result.current.settled).toBeNull();
  });

  it("holds nothing for an answer that lands after the account changed and returned", async () => {
    const held = heldDecision();
    const harness = buildHarness(held.handler);
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
      { wrapper: harness.wrapper },
    );
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST).then(
      () => "answered",
      () => "failed",
    );
    await advance(1_000);

    await switchIdentity(harness.spine, contextFor("b"));
    await switchIdentity(harness.spine, contextFor("a"));
    held.answer(SENT);
    await advance(1_000);
    // The identity change aborted the request before its answer arrived.
    expect(await decided).toBe("failed");
    card.unmount();
    await advance(GC_WINDOW_MS);

    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
    expect(useFeedbackDraftDecisionStore.getState().decisions.size).toBe(0);
  });

  it("holds nothing for an answer delivered in the instant the context it was sent in changed", async () => {
    const held = heldDecision();
    const harness = buildHarness(held.handler);
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
      { wrapper: harness.wrapper },
    );
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST).then(
      () => "answered",
      () => "failed",
    );
    await advance(1_000);

    await act(async () => {
      held.answer(SENT);
      harness.spine.setRequestContext(contextFor("b"));
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(await decided).toBe("answered");
    card.unmount();
    await switchIdentity(harness.spine, contextFor("a"));
    await advance(GC_WINDOW_MS);

    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
    expect(useFeedbackDraftDecisionStore.getState().decisions.size).toBe(0);
  });

  it("holds nothing for an answer that lands after the draft's row resolved", async () => {
    const held = heldDecision();
    const harness = buildHarness(held.handler);
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
      { wrapper: harness.wrapper },
    );
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST);
    await advance(1_000);
    renderHook(
      () => useRetireFeedbackDraftDecision(harness.client, DRAFT, true),
      { wrapper: harness.wrapper },
    );

    held.answer(SENT);
    await advance(1_000);
    await expect(decided).resolves.toEqual(SENT);

    expect(useFeedbackDraftDecisionStore.getState().decisions.size).toBe(0);
    card.unmount();
    await advance(GC_WINDOW_MS);
    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
  });
});
