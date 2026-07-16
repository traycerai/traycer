import "../../../../__tests__/test-browser-apis";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { ChatAccess } from "@traycer/protocol/host/agent/gui/subscribe";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const TEST_ID = "chat-progress";
const RUNNING_TEST_ID = `${TEST_ID}-activity-${CHAT_ID}`;
const TURN_RUNNING_LABEL = "Chat in progress";
const BACKGROUND_RUNNING_LABEL = "Background tasks running — chat idle";

const MONITOR_ITEM = {
  taskId: "task-1",
  kind: "monitor" as const,
  title: "Monitor",
  blockId: "block-1",
  parentTaskId: null,
  scheduledFor: null,
};

const mockSessionState = vi.hoisted<{
  readonly activeAgentIds: Set<string>;
  existingHandle: ChatSessionStoreHandle | null;
  epicPermissionRole: "owner" | "editor" | "viewer" | null;
}>(() => ({
  activeAgentIds: new Set<string>(),
  existingHandle: null,
  epicPermissionRole: "owner",
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicActiveAgentIds: () => mockSessionState.activeAgentIds,
  useEpicPermissionRole: () => mockSessionState.epicPermissionRole,
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
  mockSessionState.epicPermissionRole = "owner";
  for (const handle of createdHandles.splice(0)) {
    handle.dispose();
  }
});

describe("<ChatProgressIcon />", () => {
  it("shows a running spinner for an active chat without an opened session handle", () => {
    mockSessionState.activeAgentIds.add(CHAT_ID);

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Chat in progress")).not.toBeNull();
  });

  it("shows the static chat icon when an unopened chat is not active", () => {
    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).toBeNull();
    expect(screen.queryByTitle("Chat in progress")).toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).toBeNull();
  });

  it("uses resolved chat access for an Epic editor who is a chat viewer", () => {
    const handle = createHandle();
    setChatAccess(handle, "viewer");
    mockSessionState.existingHandle = handle;
    mockSessionState.epicPermissionRole = "editor";

    const { container } = renderIcon();

    expect(
      screen.getByRole("status", { name: "Read-only chat" }),
    ).toBeDefined();
    const icon = container.querySelector(".lucide-message-square-lock");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("class")).not.toContain("text-red-");
    expect(icon?.getAttribute("class")).not.toContain("text-orange-");
    expect(icon?.getAttribute("class")).not.toContain("text-green-");
  });

  it("does not show the unopened-chat fallback lock until session access is known", () => {
    const handle = createHandle();
    mockSessionState.existingHandle = handle;
    mockSessionState.epicPermissionRole = "viewer";

    const { container } = renderIcon();

    expect(screen.queryByRole("status", { name: "Read-only chat" })).toBeNull();
    expect(container.querySelector(".lucide-message-square-lock")).toBeNull();
  });

  it("does not lock a known chat owner even when the Epic fallback is viewer", () => {
    const handle = createHandle();
    setChatAccess(handle, "owner");
    mockSessionState.existingHandle = handle;
    mockSessionState.epicPermissionRole = "viewer";

    const { container } = renderIcon();

    expect(screen.queryByRole("status", { name: "Read-only chat" })).toBeNull();
    expect(container.querySelector(".lucide-message-square-lock")).toBeNull();
  });

  it("uses an accessible viewer fallback for unopened chats", () => {
    mockSessionState.epicPermissionRole = "viewer";

    renderIcon();

    expect(
      screen.getByRole("status", { name: "Read-only chat" }),
    ).toBeDefined();
  });

  it("keeps the spinner visible from runStatus when awareness is missing", () => {
    const handle = createHandle();
    handle.store.setState({ runStatus: "running" });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Chat in progress")).not.toBeNull();
  });

  it("shows the muted background indicator instead of the turn spinner when only background work runs", () => {
    const handle = createHandle();
    handle.store.setState({
      runStatus: "running",
      turnInProgress: false,
      backgroundItems: [MONITOR_ITEM],
    });
    // Epic-level activity also reads active during background-only phases;
    // the session's own tri-state must still win.
    mockSessionState.activeAgentIds.add(CHAT_ID);
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(
      screen.getByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeNull();
  });

  it("prioritizes the turn spinner when a turn and background work run simultaneously", () => {
    const handle = createHandle();
    handle.store.setState({
      runStatus: "running",
      turnInProgress: true,
      backgroundItems: [MONITOR_ITEM],
    });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(
      screen.getByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeNull();
  });

  it("keeps the running spinner for an active opened chat that needs approval", () => {
    const handle = createHandle();
    handle.store.setState({
      pendingInterviews: [{ blockId: "question-1", requestedAt: 1 }],
    });
    mockSessionState.activeAgentIds.add(CHAT_ID);
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).toBeNull();
    expect(screen.queryByTitle("Chat in progress")).not.toBeNull();
  });
});

function renderIcon() {
  return render(
    <ChatProgressIcon
      chatId={CHAT_ID}
      className={undefined}
      epicId={EPIC_ID}
      mutedClassName="text-muted-foreground"
      testId={TEST_ID}
      defaultIcon={undefined}
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

function setChatAccess(
  handle: ChatSessionStoreHandle,
  role: ChatAccess["role"],
): void {
  handle.store.setState({
    access: {
      role,
      ownerUserId: "chat-owner",
      canAct: role === "owner",
    },
  });
}
