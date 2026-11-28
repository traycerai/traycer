import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import type {
  ChatFeedbackDraftDecideRequest,
  ChatFeedbackDraftDecideResponse,
} from "@traycer/protocol/host/chat/feedback-draft";
import type { RequestContext } from "@traycer/protocol/auth/request-context";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import { HostTransportFailureError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  feedbackDraftSessionId,
  readFeedbackDraftDecision,
} from "@/lib/chats/feedback-draft-decisions";
import {
  useChatFeedbackDraftDecideMutation,
  useChatFeedbackDraftDecisionState,
} from "@/hooks/chats/use-chat-feedback-draft";

/**
 * The bot card decides the SOURCE draft through the decision store every
 * surface shares. The boundary faked is the host client the host id resolves
 * to and the host's advertised methods; the card, the hooks and the store run
 * for real over one QueryClient.
 */

interface Boundary {
  supported: boolean | null;
  clients: Record<string, HostRequester<HostRpcRegistry> | null>;
}

const boundary = vi.hoisted((): Boundary => ({ supported: true, clients: {} }));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) =>
    hostId === null ? null : (boundary.clients[hostId] ?? null),
  useHostDirectoryEntryForHostId: (hostId: string | null) =>
    hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
}));
vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => boundary.supported,
  useHostSupportsMethod: () => boundary.supported === true,
}));
vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => null,
}));

import { BotFeedbackDraftCard } from "@/components/bots/bot-feedback-draft-card";
import {
  gate,
  PENDING,
  SOURCE,
  UNAVAILABLE_COPY,
  until,
  untilIdle,
  type Gate,
} from "./bot-feedback-draft-card-test-support";

const OTHER_SOURCE = { ...SOURCE, blockId: "block-2" } as const;

const SENT: ToolCallFeedbackDraftStamp = {
  ...PENDING,
  state: "sent",
  decidedAt: 5,
};

let requestCounter = 0;
let decideCalls: ChatFeedbackDraftDecideRequest[] = [];
let decideGate: Gate<ChatFeedbackDraftDecideResponse>;
/** While set, the host never answers a decide: the transport fails. */
let decideTransportFails = false;
let spine: HostClient<HostRpcRegistry>;
let requester: HostRequester<HostRpcRegistry>;
let queryClient: QueryClient;

function newContext(): RequestContext {
  return createRequestContextFixture({
    origin: "renderer",
    bearerToken: `tok-${String(++requestCounter)}`,
  });
}

function buildSpine(): HostClient<HostRpcRegistry> {
  const built = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `request-${String(++requestCounter)}`,
      handlers: {
        "chat.feedbackDraft.decide": (params) => {
          decideCalls.push(params);
          if (decideTransportFails) {
            throw new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "connection lost",
              requestId: "lost",
              method: "chat.feedbackDraft.decide",
              fatalDetails: null,
            });
          }
          return decideGate.promise;
        },
        "chat.feedbackDraft.preview": () => ({
          kind: "preview",
          details: [],
          logTail: "",
          logTailTruncated: false,
        }),
      },
    }),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
  });
  built.setRequestContext(newContext());
  return built;
}

/** Another surface on the source draft: its own mutation and the shared state. */
function Probe(): ReactNode {
  const decide = useChatFeedbackDraftDecideMutation(requester, SOURCE);
  const state = useChatFeedbackDraftDecisionState(requester, SOURCE);
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          decide.mutate({
            epicId: SOURCE.epicId,
            chatId: SOURCE.chatId,
            blockId: SOURCE.blockId,
            decision: "send",
            includeDiagnostics: false,
            clientActionId: "probe-click",
          })
        }
      >
        Probe send
      </button>
      <output data-testid="probe-pending">{String(state.isPending)}</output>
      <output data-testid="probe-settled">
        {state.settled === null ? "none" : state.settled.state}
      </output>
    </div>
  );
}

function tree(draft: ToolCallFeedbackDraftStamp, probe: boolean): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {probe ? <Probe /> : null}
      <BotFeedbackDraftCard source={{ ...SOURCE }} draft={{ ...draft }} />
    </QueryClientProvider>
  );
}

function renderCard(
  draft: ToolCallFeedbackDraftStamp,
  probe: boolean,
): { readonly rerender: (next: ToolCallFeedbackDraftStamp) => void } {
  const view = render(tree(draft, probe));
  return { rerender: (next) => view.rerender(tree(next, probe)) };
}

function probeText(id: "probe-pending" | "probe-settled"): string | null {
  return screen.getByTestId(id).textContent;
}

function held(context: RequestContext) {
  return readFeedbackDraftDecision(
    queryClient,
    feedbackDraftSessionId(context),
    SOURCE,
  );
}

function currentContext(): RequestContext {
  const context = requester.getRequestContext();
  if (context === null) throw new Error("the client has no request context");
  return context;
}

const NOT_ALLOWED_COPY = "Only someone who can act in this chat can send it.";

beforeEach(() => {
  vi.useFakeTimers();
  requestCounter = 0;
  decideCalls = [];
  decideGate = gate();
  decideTransportFails = false;
  boundary.supported = true;
  queryClient = new QueryClient();
  spine = buildSpine();
  requester = spine.createRequester(mockLocalHostEntry);
  boundary.clients = { [SOURCE.hostId]: requester };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<BotFeedbackDraftCard /> over the shared decision store", () => {
  it("shows another surface's decision in flight, then its sent stamp, while the projection is still pending", async () => {
    renderCard(PENDING, true);
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Probe send" }));
    await until(() => expect(decideCalls).toHaveLength(1));
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Skip" }).hasAttribute("disabled"),
    ).toBe(true);

    decideGate.resolve({ kind: "settled", feedbackDraft: SENT });
    await until(() => expect(screen.getByText("Sent")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(decideCalls).toHaveLength(1);
  });

  it("reports the bot card's Send as pending, then sent, to another reader of the source address", async () => {
    renderCard(PENDING, true);
    expect(probeText("probe-pending")).toBe("false");
    expect(probeText("probe-settled")).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() => expect(probeText("probe-pending")).toBe("true"));

    decideGate.resolve({ kind: "settled", feedbackDraft: SENT });
    await until(() => expect(probeText("probe-settled")).toBe("sent"));

    expect(probeText("probe-pending")).toBe("false");
  });

  it("never settles the held decision when the projection turns terminal", async () => {
    const view = renderCard(PENDING, false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() => expect(decideCalls).toHaveLength(1));
    decideGate.resolve({ kind: "settled", feedbackDraft: SENT });
    await until(() => expect(screen.getByText("Sent")).toBeTruthy());

    view.rerender(SENT);

    const entry = held(currentContext());
    expect(entry?.settled).toEqual({ card: false, row: false });
  });

  it("is not pending, and shows the terminal draft, once the projection is terminal with the decision still held", async () => {
    const view = renderCard(PENDING, true);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() => expect(decideCalls).toHaveLength(1));
    decideGate.resolve({ kind: "settled", feedbackDraft: SENT });
    await until(() => expect(probeText("probe-settled")).toBe("sent"));

    view.rerender(SENT);

    expect(held(currentContext())?.stamp).toEqual(SENT);
    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_COPY)).toBeNull();
    expect(probeText("probe-pending")).toBe("false");
  });
});

const SWITCHES: ReadonlyArray<readonly [string, () => RequestContext | null]> =
  [
    ["a new account context", () => newContext()],
    ["signed out", () => null],
  ];

describe("<BotFeedbackDraftCard /> across an account switch", () => {
  async function failSend(): Promise<{
    readonly rerender: (next: ToolCallFeedbackDraftStamp) => void;
  }> {
    decideTransportFails = true;
    const view = renderCard(PENDING, false);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() =>
      expect(screen.getByRole("button", { name: "Retry Send" })).toBeTruthy(),
    );
    decideTransportFails = false;
    return view;
  }

  it.each(SWITCHES)(
    "drops Retry Send after the client switches to %s, and a stale Retry press sends nothing",
    async (_label, next: () => RequestContext | null) => {
      await failSend();
      expect(decideCalls).toHaveLength(1);
      const retry = screen.getByRole("button", { name: "Retry Send" });

      // The switch is announced to React but not yet rendered: the press
      // lands on the button the previous session drew.
      spine.setRequestContext(next());
      fireEvent.click(retry);
      await until(() =>
        expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull(),
      );
      await untilIdle(queryClient);

      expect(decideCalls).toHaveLength(1);
      expect(screen.queryByRole("button", { name: "Retry Skip" })).toBeNull();
    },
  );

  it.each(SWITCHES)(
    "shows no Retry once the client has switched to %s and the card has re-rendered",
    async (_label, next: () => RequestContext | null) => {
      await failSend();
      expect(screen.getByRole("button", { name: "Retry Send" })).toBeTruthy();

      act(() => {
        spine.setRequestContext(next());
      });
      await until(() =>
        expect(screen.queryByRole("button", { name: "Retry Send" })).toBeNull(),
      );
      await untilIdle(queryClient);

      expect(decideCalls).toHaveLength(1);
    },
  );

  it("sends a fresh Send in a new session under a different click id", async () => {
    await failSend();
    const first = decideCalls[0];

    act(() => {
      spine.setRequestContext(newContext());
    });
    await until(() =>
      expect(screen.getByRole("button", { name: "Send" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() => expect(decideCalls).toHaveLength(2));

    expect(decideCalls[1].decision).toBe("send");
    expect(decideCalls[1].clientActionId).not.toBe(first.clientActionId);
  });

  it("shows a spinner inside Retry only while the retried decision is in flight", async () => {
    await failSend();
    const retry = screen.getByRole("button", { name: "Retry Send" });
    expect(retry.querySelector('[aria-hidden="true"]')).toBeNull();

    fireEvent.click(retry);
    await until(() =>
      expect(
        screen
          .getByRole("button", { name: "Retry Send" })
          .hasAttribute("disabled"),
      ).toBe(true),
    );

    const pendingRetry = screen.getByRole("button", { name: "Retry Send" });
    expect(pendingRetry.hasAttribute("disabled")).toBe(true);
    expect(pendingRetry.textContent).toContain("Retry Send");
    expect(pendingRetry.querySelector('[aria-hidden="true"]')).not.toBeNull();

    decideGate.resolve({
      kind: "error",
      code: "session-unavailable",
      feedbackDraft: null,
    });
    await until(() =>
      expect(
        screen
          .getByRole("button", { name: "Retry Send" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );

    const failedRetry = screen.getByRole("button", { name: "Retry Send" });
    expect(failedRetry.hasAttribute("disabled")).toBe(false);
    expect(failedRetry.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("repeats the failed click id on Retry in the same session", async () => {
    await failSend();
    const first = decideCalls[0];

    fireEvent.click(screen.getByRole("button", { name: "Retry Send" }));
    await until(() => expect(decideCalls).toHaveLength(2));

    expect(decideCalls[1].clientActionId).toBe(first.clientActionId);
  });
});

describe("<BotFeedbackDraftCard /> when the projection lags the decision", () => {
  it("offers Send and Skip with an empty store, then shows the sent stamp from an already-decided answer after one request", async () => {
    renderCard(PENDING, false);
    expect(held(currentContext())).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: "Skip" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await until(() => expect(decideCalls).toHaveLength(1));
    decideGate.resolve({
      kind: "error",
      code: "already-decided",
      feedbackDraft: SENT,
    });
    await until(() => expect(screen.getByText("Sent")).toBeTruthy());

    expect(screen.queryByText(UNAVAILABLE_COPY)).toBeNull();
    expect(screen.queryByText(NOT_ALLOWED_COPY)).toBeNull();
    await untilIdle(queryClient);
    expect(decideCalls).toHaveLength(1);
  });
});

describe("<BotFeedbackDraftCard /> refusals", () => {
  it("keeps a not-allowed refusal on the card that was refused", async () => {
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Probe />
        <div data-testid="refused-card">
          <BotFeedbackDraftCard source={{ ...SOURCE }} draft={{ ...PENDING }} />
        </div>
        <div data-testid="other-card">
          <BotFeedbackDraftCard
            source={{ ...OTHER_SOURCE }}
            draft={{ ...PENDING }}
          />
        </div>
      </QueryClientProvider>,
    );
    const refused = within(screen.getByTestId("refused-card"));
    const other = within(screen.getByTestId("other-card"));
    expect(screen.getAllByRole("button", { name: "Send" })).toHaveLength(2);

    fireEvent.click(refused.getByRole("button", { name: "Send" }));
    await until(() => expect(decideCalls).toHaveLength(1));
    decideGate.resolve({
      kind: "error",
      code: "not-allowed",
      feedbackDraft: null,
    });
    await until(() => expect(refused.getByText(NOT_ALLOWED_COPY)).toBeTruthy());

    expect(refused.queryByRole("button", { name: "Send" })).toBeNull();
    // The other card, on another block, still offers its actions, and the
    // shared state for the refused address carries no stamp and no pending.
    expect(
      other.getByRole("button", { name: "Send" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(other.queryByText(NOT_ALLOWED_COPY)).toBeNull();
    expect(probeText("probe-pending")).toBe("false");
    expect(probeText("probe-settled")).toBe("none");
    expect(decideCalls).toHaveLength(1);
    view.unmount();
  });
});
