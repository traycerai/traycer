import "../../../../__tests__/test-browser-apis";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const TEST_ID = "chat-progress";

const mockSessionState = vi.hoisted<{
  readonly activeAgentIds: Set<string>;
  existingHandle: ChatSessionStoreHandle | null;
}>(() => ({
  activeAgentIds: new Set<string>(),
  existingHandle: null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicActiveAgentIds: () => mockSessionState.activeAgentIds,
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => mockSessionState.existingHandle,
}));

import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";

const createdHandles: ChatSessionStoreHandle[] = [];

afterEach(() => {
  cleanup();
  mockSessionState.activeAgentIds.clear();
  mockSessionState.existingHandle = null;
  for (const handle of createdHandles.splice(0)) {
    handle.dispose();
  }
});

describe("<ChatProgressIcon />", () => {
  it("shows a running spinner for an active chat without an opened session handle", () => {
    mockSessionState.activeAgentIds.add(CHAT_ID);

    renderIcon();

    expect(screen.queryByTestId(TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Chat in progress")).not.toBeNull();
  });

  it("shows the static chat icon when an unopened chat is not active", () => {
    renderIcon();

    expect(screen.queryByTestId(TEST_ID)).toBeNull();
    expect(screen.queryByTitle("Chat in progress")).toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).toBeNull();
  });

  it("keeps the spinner visible from runStatus when awareness is missing", () => {
    const handle = createHandle();
    handle.store.setState({ runStatus: "running" });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Chat in progress")).not.toBeNull();
  });

  it("uses the waiting spinner when an active opened chat needs approval", () => {
    const handle = createHandle();
    handle.store.setState({
      pendingInterviews: [{ blockId: "question-1", requestedAt: 1 }],
    });
    mockSessionState.activeAgentIds.add(CHAT_ID);
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).not.toBeNull();
    expect(screen.queryByTitle("Chat in progress")).toBeNull();
  });
});

function renderIcon(): void {
  render(
    <ChatProgressIcon
      chatId={CHAT_ID}
      className={undefined}
      epicId={EPIC_ID}
      mutedClassName="text-muted-foreground"
      testId={TEST_ID}
    />,
  );
}

function createHandle(): ChatSessionStoreHandle {
  const handle = createChatSessionStore({
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      close: () => undefined,
    }),
  });
  createdHandles.push(handle);
  return handle;
}
