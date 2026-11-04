import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import type { ChatFeedbackDraftDecideResponse } from "@traycer/protocol/host/chat/feedback-draft";
import type { ToolCallFeedbackDraftStamp } from "@traycer/protocol/persistence/epic/content-blocks";
import {
  ChatAttachmentScopeContext,
  type ChatAttachmentScopeValue,
} from "@/components/chat/chat-attachment-scope-context";
import { FeedbackDraftCard } from "@/components/chat/segments/feedback-draft-card";
import { useToolOpenStore } from "@/stores/chats/tool-open-store";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  decideData: undefined as ChatFeedbackDraftDecideResponse | undefined,
  supported: true as boolean | null,
  canAct: true as boolean | null,
}));

// The host boundary: the RPC hooks and the chat's live session. The card's
// own logic runs for real.
vi.mock("@/hooks/chats/use-chat-feedback-draft", () => ({
  useChatFeedbackDraftSupported: () => mocks.supported,
  useChatFeedbackDraftDecideMutation: () => ({
    mutate: mocks.mutate,
    isPending: false,
    data: mocks.decideData,
  }),
  useChatFeedbackDraftPreviewQuery: () => ({
    isPending: false,
    data: {
      kind: "preview",
      details: [{ label: "Host version", value: "1.6.0" }],
      logTail: "[2026-11-03 10:00:00.000] [INFO] started",
      logTailTruncated: false,
    },
  }),
}));

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

function renderCard(
  draft: ToolCallFeedbackDraftStamp,
  scope: ChatAttachmentScopeValue | null,
): void {
  const wrap = (children: ReactNode): ReactNode => (
    <ChatAttachmentScopeContext.Provider value={scope}>
      {children}
    </ChatAttachmentScopeContext.Provider>
  );
  render(
    wrap(
      <FeedbackDraftCard id="block-1" draft={draft} headerFindUnitId={null} />,
    ),
  );
}

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.decideData = undefined;
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

  it("shows the settled stamp the decision answered before the row update lands", () => {
    mocks.decideData = {
      kind: "settled",
      feedbackDraft: { ...PENDING, state: "skipped", decidedAt: 5 },
    };
    renderCard(PENDING, SCOPE);

    expect(screen.getByText("Skipped")).toBeTruthy();
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
});
