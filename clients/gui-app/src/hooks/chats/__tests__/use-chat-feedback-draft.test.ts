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
import {
  feedbackDraftSessionId,
  readFeedbackDraftDecision,
} from "@/lib/chats/feedback-draft-decisions";
import { feedbackDraftQueryKeys } from "@/lib/query-keys";
import {
  feedbackDraftRefusalMessage,
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
  useSettleFeedbackDraftDecision,
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
  readonly queryClient: QueryClient;
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
    queryClient,
    spine,
    client: spine.createRequester(mockLocalHostEntry),
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client: queryClient }, children),
  };
}

/** The account session the harness's client currently resolves to. */
function sessionOf(harness: Harness): number {
  const context = harness.client.getRequestContext();
  if (context === null) throw new Error("the harness client has a session");
  return feedbackDraftSessionId(context);
}

/** The stamp held for the draft in the harness's session, `null` when none is. */
function heldStamp(harness: Harness) {
  return (
    readFeedbackDraftDecision(harness.queryClient, sessionOf(harness), DRAFT)
      ?.stamp ?? null
  );
}

/** How many held-decision entries, tombstones included, the query cache has. */
function heldEntryCount(harness: Harness): number {
  return harness.queryClient
    .getQueryCache()
    .findAll({ queryKey: feedbackDraftQueryKeys.decisions() }).length;
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

/**
 * A requester that forwards everything to the real one, and runs `afterFirstRead`
 * right after the first `getRequestContext()` it answers once `arm()` was called.
 * That read may be a render's rather than `onMutate`'s, so a test proves the
 * ordering from the context `onMutate` stored, not from this hook firing.
 */
class ContextHookedRequester implements HostRequester<HostRpcRegistry> {
  private armed = false;
  private fired = false;

  constructor(
    private readonly inner: HostRequester<HostRpcRegistry>,
    private readonly afterFirstRead: () => void,
  ) {}

  arm(): void {
    this.armed = true;
  }
  getRegistry(): HostRpcRegistry {
    return this.inner.getRegistry();
  }
  getActiveHost: HostRequester<HostRpcRegistry>["getActiveHost"] = () =>
    this.inner.getActiveHost();
  getActiveHostId: HostRequester<HostRpcRegistry>["getActiveHostId"] = () =>
    this.inner.getActiveHostId();
  getRequestContext(): RequestContext | null {
    const context = this.inner.getRequestContext();
    if (this.armed && !this.fired) {
      this.fired = true;
      this.afterFirstRead();
    }
    return context;
  }
  getRequestContextUserId(): string | null {
    return this.inner.getRequestContextUserId();
  }
  onChange: HostRequester<HostRpcRegistry>["onChange"] = (handler) =>
    this.inner.onChange(handler);
  request: HostRequester<HostRpcRegistry>["request"] = (method, params) =>
    this.inner.request(method, params);
  requestWithIdempotencyKey: HostRequester<HostRpcRegistry>["requestWithIdempotencyKey"] =
    (method, params, key) =>
      this.inner.requestWithIdempotencyKey(method, params, key);
  requestWithOptions: HostRequester<HostRpcRegistry>["requestWithOptions"] = (
    method,
    params,
    options,
  ) => this.inner.requestWithOptions(method, params, options);
  requestWithSignal: HostRequester<HostRpcRegistry>["requestWithSignal"] = (
    method,
    params,
    signal,
  ) => this.inner.requestWithSignal(method, params, signal);
  requestWithSignalRequiringHostMethodVersion: HostRequester<HostRpcRegistry>["requestWithSignalRequiringHostMethodVersion"] =
    (method, params, signal, floor) =>
      this.inner.requestWithSignalRequiringHostMethodVersion(
        method,
        params,
        signal,
        floor,
      );
  requestWithResponseTimeout: HostRequester<HostRpcRegistry>["requestWithResponseTimeout"] =
    (method, params, ms) =>
      this.inner.requestWithResponseTimeout(method, params, ms);
}

describe("feedback draft decision state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
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

  it("drops the held decision only once both the card and the row have settled", async () => {
    const harness = buildHarness(() => SENT);
    await decideFromClosedCard(harness);
    const row = mountReader(harness);
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);

    renderHook(
      () => useSettleFeedbackDraftDecision(harness.client, DRAFT, "card", true),
      { wrapper: harness.wrapper },
    );
    expect(row.result.current.settled).toEqual(SENT.feedbackDraft);

    renderHook(
      () => useSettleFeedbackDraftDecision(harness.client, DRAFT, "row", true),
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
    expect(heldStamp(harness)).toBeNull();
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
    // Nothing was recorded under the session the decision was sent in, before any later session exists.
    expect(heldEntryCount(harness)).toBe(0);
    card.unmount();
    await switchIdentity(harness.spine, contextFor("a"));
    await advance(GC_WINDOW_MS);

    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
    expect(heldStamp(harness)).toBeNull();
  });

  it("holds nothing for an answer that lands after both the card and the row settled", async () => {
    const held = heldDecision();
    const harness = buildHarness(held.handler);
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(harness.client, DRAFT),
      { wrapper: harness.wrapper },
    );
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST);
    await advance(1_000);
    for (const consumer of ["card", "row"] as const) {
      renderHook(
        () =>
          useSettleFeedbackDraftDecision(harness.client, DRAFT, consumer, true),
        { wrapper: harness.wrapper },
      );
    }

    held.answer(SENT);
    await advance(1_000);
    await expect(decided).resolves.toEqual(SENT);

    expect(heldStamp(harness)).toBeNull();
    card.unmount();
    await advance(GC_WINDOW_MS);
    const row = mountReader(harness);
    expect(row.result.current.settled).toBeNull();
  });
  it("dispatches nothing when the account changes after the decision started and before it is sent", async () => {
    let dispatched = 0;
    const harness = buildHarness(() => {
      dispatched += 1;
      return SENT;
    });
    const hooked = new ContextHookedRequester(harness.client, () => {
      queueMicrotask(() => {
        harness.spine.setRequestContext(contextFor("b"));
      });
    });
    const card = renderHook(
      () => useChatFeedbackDraftDecideMutation(hooked, DRAFT),
      { wrapper: harness.wrapper },
    );
    const contextA = harness.client.getRequestContext();
    hooked.arm();
    const decided = card.result.current.mutateAsync(DECIDE_REQUEST).then(
      () => "answered",
      () => "failed",
    );
    await advance(1_000);

    const outcome = await decided;
    const contextB = harness.client.getRequestContext();
    expect(contextB).not.toBe(contextA);
    // onMutate captured A, and the live context at dispatch time was B.
    const [mutation] = harness.queryClient.getMutationCache().findAll();
    expect(Reflect.get(Object(mutation.state.context), "context")).toBe(
      contextA,
    );
    expect(dispatched).toBe(0);
    expect(outcome).toBe("failed");
    expect(heldEntryCount(harness)).toBe(0);
  });

  it.each([
    { first: "row", second: "card" },
    { first: "card", second: "row" },
  ] as const)(
    "keeps a sent decision when $first settles alone, and drops it when $second settles too",
    async ({ first, second }) => {
      const harness = buildHarness(() => SENT);
      await decideFromClosedCard(harness);

      renderHook(
        () =>
          useSettleFeedbackDraftDecision(harness.client, DRAFT, first, true),
        { wrapper: harness.wrapper },
      );
      await advance(GC_WINDOW_MS);
      const reader = mountReader(harness);
      expect(reader.result.current.settled).toEqual(SENT.feedbackDraft);

      renderHook(
        () =>
          useSettleFeedbackDraftDecision(harness.client, DRAFT, second, true),
        { wrapper: harness.wrapper },
      );
      expect(reader.result.current.settled).toBeNull();
    },
  );
});
