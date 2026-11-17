import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { feedbackDraftMutationKeys } from "@/lib/query-keys";
import { useFeedbackDraftDecisionStore } from "@/stores/chats/feedback-draft-decision-store";
import { FeedbackDraftCard } from "@/components/chat/segments/feedback-draft-card";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  supported: true as boolean | null,
  canAct: true as boolean | null,
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
  useHostClientForHostId: () => null,
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

function renderCard(
  draft: ToolCallFeedbackDraftStamp,
  scope: ChatAttachmentScopeValue | null,
): void {
  const wrap = (children: ReactNode): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <ChatAttachmentScopeContext.Provider value={scope}>
        {children}
      </ChatAttachmentScopeContext.Provider>
    </QueryClientProvider>
  );
  render(
    wrap(
      <FeedbackDraftCard id="block-1" draft={draft} headerFindUnitId={null} />,
    ),
  );
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
  useFeedbackDraftDecisionStore.setState({
    sessionId: null,
    decisions: new Map(),
    resolved: new Set(),
  });
  mocks.mutate.mockReset();
  mocks.supported = true;
  mocks.canAct = true;
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
});
