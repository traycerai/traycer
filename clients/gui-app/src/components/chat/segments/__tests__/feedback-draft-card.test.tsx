import {
  act,
  cleanup,
  fireEvent,
  render,
  type RenderResult,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { feedbackDraftMutationKeys } from "@/lib/query-keys";
import {
  feedbackDraftSessionId,
  readFeedbackDraftDecision,
  recordFeedbackDraftDecision,
  settleFeedbackDraftDecision,
} from "@/lib/chats/feedback-draft-decisions";
import {
  FeedbackDraftCard,
  FeedbackDraftView,
  type LiveDraftActions,
} from "@/components/chat/segments/feedback-draft-card";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  supported: true as boolean | null,
  canAct: true as boolean | null,
  client: null as HostRequester<HostRpcRegistry> | null,
}));

// The host boundary: the RPC hooks and the chat's live session. The card's
// own logic, and the decision state it reads from the mutation cache, run
// for real.
vi.mock("@/hooks/chats/use-chat-feedback-draft", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/hooks/chats/use-chat-feedback-draft")
    >();
  return {
    ...actual,
    useChatFeedbackDraftSupported: () => mocks.supported,
    useChatFeedbackDraftDecideMutation: () => ({ mutate: mocks.mutate }),
    useChatFeedbackDraftPreviewQuery: () => ({
      isPending: false,
      data: {
        kind: "preview",
        details: [{ label: "Host version", value: "1.6.0" }],
        logTail: "[2026-11-03 10:00:00.000] [INFO] started",
        logTailTruncated: false,
      },
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => mocks.client,
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => ({
    store: create(() => ({
      access: mocks.canAct === null ? null : { canAct: mocks.canAct },
    })),
  }),
}));

const SCOPE: ChatAttachmentScopeValue = {
  epicId: "epic-1",
  chatId: "chat-1",
  hostId: "host-1",
  hostVersion: null,
  client: null,
};

const PENDING: ToolCallFeedbackDraftStamp = {
  category: "tool_problem",
  toolName: "traycer_run_shell",
  goal: "Restart a shell with a new working directory.",
  observed: "The process kept the old directory.",
  suggestion: null,
  suggestDiagnostics: true,
  state: "pending",
  decidedAt: null,
  failureReason: null,
};

let queryClient = new QueryClient();

const CARD_HOST: HostDirectoryEntry = {
  hostId: SCOPE.hostId,
  label: "Card computer",
  kind: "local",
  websocketUrl: null,
  version: null,
  transportDialability: "dialable",
};

/** Gives the card a client with a request context, and returns its session id. */
function giveCardASession(): number {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "request-1",
      handlers: {},
    }),
    findHostById: () => CARD_HOST,
  });
  const context = createRequestContextFixture({
    origin: "renderer",
    bearerToken: "token-a",
    identity: { userId: "user-a", username: "a", providerHandle: null },
  });
  spine.setRequestContext(context);
  mocks.client = spine.createRequester(CARD_HOST);
  return feedbackDraftSessionId(context);
}

function cardTree(
  draft: ToolCallFeedbackDraftStamp,
  scope: ChatAttachmentScopeValue | null,
): ReactNode {
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <ChatAttachmentScopeContext.Provider value={scope}>
        {children}
      </ChatAttachmentScopeContext.Provider>
    </QueryClientProvider>
  );
  return wrap(
    <FeedbackDraftCard id="block-1" draft={draft} headerFindUnitId={null} />,
  );
}

function renderCard(
  draft: ToolCallFeedbackDraftStamp,
  scope: ChatAttachmentScopeValue | null,
): RenderResult {
  return render(cardTree(draft, scope));
}

/** A decision on the card's draft, made on another surface or on the card. */
function decideCardDraft(
  response: Promise<ChatFeedbackDraftDecideResponse>,
): Promise<ChatFeedbackDraftDecideResponse> {
  return queryClient
    .getMutationCache()
    .build(queryClient, {
      mutationKey: feedbackDraftMutationKeys.decide({
        hostId: SCOPE.hostId,
        sessionId: null,
        epicId: SCOPE.epicId,
        chatId: SCOPE.chatId,
        blockId: "block-1",
      }),
      mutationFn: () => response,
    })
    .execute(undefined);
}

beforeEach(() => {
  queryClient = new QueryClient();
  mocks.mutate.mockReset();
  mocks.supported = true;
  mocks.canAct = true;
  mocks.client = null;
  useToolOpenStore.setState({ openIds: new Set() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("FeedbackDraftCard", () => {
  it("shows a pending draft with the box ticked as the agent suggested, and sends with diagnostics", () => {
    renderCard(PENDING, SCOPE);

    expect(
      screen.getByText(
        "Feedback for Traycer · Tool problem · traycer_run_shell",
      ),
    ).toBeTruthy();
    expect(screen.getByText(PENDING.goal)).toBeTruthy();
    expect(screen.getByText(PENDING.observed)).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Include diagnostic data" }),
    ).toHaveProperty("dataset.state", "checked");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        chatId: "chat-1",
        blockId: "block-1",
        decision: "send",
        includeDiagnostics: true,
      }),
    );
  });

  it("sends without diagnostics once the box is unticked, and skips with none", () => {
    renderCard(PENDING, SCOPE);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include diagnostic data" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    expect(mocks.mutate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ decision: "send", includeDiagnostics: false }),
    );
    expect(mocks.mutate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ decision: "skip", includeDiagnostics: false }),
    );
  });

  it("shows the scrubbed diagnostics on View", () => {
    renderCard(PENDING, SCOPE);
    fireEvent.click(screen.getByRole("button", { name: "View" }));

    expect(
      screen.getByText("[2026-11-03 10:00:00.000] [INFO] started"),
    ).toBeTruthy();
    expect(screen.getByText("1.6.0")).toBeTruthy();
  });

  it.each([
    [
      "a reader who may not act",
      () => {
        mocks.canAct = false;
      },
      SCOPE,
      "Only someone who can act in this chat can send it.",
    ],
    [
      "a host without the method",
      () => {
        mocks.supported = false;
      },
      SCOPE,
      "Update Traycer on this computer to send it.",
    ],
    [
      "a transcript with no live chat",
      () => {},
      null,
      "Open this chat in the desktop app to send it.",
    ],
  ] as const)("is read-only for %s", (_label, arrange, scope, copy) => {
    arrange();
    renderCard(PENDING, scope);

    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("collapses a settled draft to its header and state", () => {
    renderCard({ ...PENDING, state: "sent", decidedAt: 5 }, SCOPE);

    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByText(PENDING.goal)).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("shows the settled stamp the decision answered before the row update lands", async () => {
    await decideCardDraft(
      Promise.resolve({
        kind: "settled",
        feedbackDraft: { ...PENDING, state: "skipped", decidedAt: 5 },
      }),
    );
    renderCard(PENDING, SCOPE);

    expect(await screen.findByText("Skipped")).toBeTruthy();
  });

  it("shows a draft as sent when its notification row's decision sent it", async () => {
    renderCard(PENDING, SCOPE);
    await decideCardDraft(
      Promise.resolve({
        kind: "settled",
        feedbackDraft: { ...PENDING, state: "sent", decidedAt: 5 },
      }),
    );

    expect(await screen.findByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("offers Send again on a failed send, with its reason", () => {
    renderCard(
      { ...PENDING, state: "failed", decidedAt: 5, failureReason: "offline" },
      SCOPE,
    );

    expect(
      screen.getByText("Not sent: offline. You can try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("holds Send and Skip while a decision on the draft is out from elsewhere", async () => {
    renderCard(PENDING, SCOPE);
    void decideCardDraft(new Promise(() => {}));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty(
        "disabled",
        true,
      );
    });
    expect(screen.getByRole("button", { name: "Skip" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("keeps a held sent decision while its transcript reads pending, and keeps it after the transcript settles until the row has too", () => {
    const sessionId = giveCardASession();
    const address = {
      hostId: SCOPE.hostId,
      epicId: SCOPE.epicId,
      chatId: SCOPE.chatId,
      blockId: "block-1",
    };
    const sent = { ...PENDING, state: "sent", decidedAt: 5 } as const;
    recordFeedbackDraftDecision(queryClient, sessionId, address, sent);
    const view = renderCard(PENDING, SCOPE);

    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);

    view.rerender(cardTree(sent, SCOPE));

    expect(readFeedbackDraftDecision(queryClient, sessionId, address)).toEqual({
      stamp: sent,
      settled: { card: true, row: false },
    });

    act(() => {
      settleFeedbackDraftDecision(queryClient, sessionId, address, "row");
    });

    expect(
      readFeedbackDraftDecision(queryClient, sessionId, address)?.stamp ?? null,
    ).toBeNull();
  });
});

describe("FeedbackDraftView diagnostics preview", () => {
  function viewTree(readOnly: LiveDraftActions["readOnly"]): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <FeedbackDraftView
          id="block-1"
          draft={PENDING}
          headerFindUnitId={null}
          live={{
            blockRef: {
              epicId: SCOPE.epicId,
              chatId: SCOPE.chatId,
              blockId: "block-1",
            },
            client: null,
            readOnly,
            isPending: false,
            decide: vi.fn(),
          }}
        />
      </QueryClientProvider>
    );
  }

  it("keeps an unticked diagnostics box and leaves the preview closed when the actions return from read-only", () => {
    const view = render(viewTree(null));
    const box = (): HTMLElement =>
      screen.getByRole("checkbox", { name: "Include diagnostic data" });
    expect(box()).toHaveProperty("dataset.state", "checked");
    fireEvent.click(box());
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    view.rerender(viewTree("source-unavailable"));
    view.rerender(viewTree(null));

    expect(box()).toHaveProperty("dataset.state", "unchecked");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("1.6.0")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByText("1.6.0")).toBeTruthy();
  });
});
