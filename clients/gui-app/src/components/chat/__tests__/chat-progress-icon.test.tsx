import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import type { ChatAccess } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const TEST_ID = "chat-progress";
const RUNNING_TEST_ID = `${TEST_ID}-activity-${CHAT_ID}`;
const BACKGROUND_TEST_ID = `${TEST_ID}-background-activity-${CHAT_ID}`;
const TURN_RUNNING_LABEL = "Agent in progress";
const BACKGROUND_RUNNING_LABEL = "Background activity — agent idle";

const MONITOR_ITEM = {
  taskId: "task-1",
  kind: "monitor" as const,
  title: "Monitor",
  blockId: "block-1",
  parentTaskId: null,
  scheduledFor: null,
};

// A shell outlives the turn that started it, so the chat around it reads idle.
const RUNNING_SHELL: ManagedCommand = {
  id: "cmd-1",
  monitoring: false,
  description: "dev server",
  status: { state: "running", pid: 4242, startedAtMs: 1 },
  chatId: CHAT_ID,
  createdAtMs: 1,
  updatedAtMs: 1,
};

// Awareness reports a TIER per working agent, not bare membership: a host that
// classifies its agents distinguishes an active turn from background-only work,
// and one that does not reports every working agent as "turn".
const mockSessionState = vi.hoisted<{
  readonly activityTiers: Map<string, "turn" | "background">;
  existingHandle: ChatSessionStoreHandle | null;
  epicPermissionRole: "owner" | "editor" | "viewer" | null;
}>(() => ({
  activityTiers: new Map<string, "turn" | "background">(),
  existingHandle: null,
  epicPermissionRole: "owner",
}));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicAgentActivityTiers: () => mockSessionState.activityTiers,
  useEpicPermissionRole: () => mockSessionState.epicPermissionRole,
}));

vi.mock("@/lib/registries/chat-session-registry", () => ({
  useExistingChatSessionHandle: () => mockSessionState.existingHandle,
}));

import { ChatProgressIcon } from "@/components/chat/chat-progress-icon";

import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
const createdHandles: ChatSessionStoreHandle[] = [];

afterEach(() => {
  cleanup();
  mockSessionState.activityTiers.clear();
  mockSessionState.existingHandle = null;
  mockSessionState.epicPermissionRole = "owner";
  for (const handle of createdHandles.splice(0)) {
    handle.dispose();
  }
});

describe("<ChatProgressIcon />", () => {
  it("shows a running spinner for an active chat without an opened session handle", () => {
    mockSessionState.activityTiers.set(CHAT_ID, "turn");

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(tooltipTextNear(screen.getByTestId(RUNNING_TEST_ID))).toBe(
      "Agent in progress",
    );
  });

  it("shows the static chat icon when an unopened chat is not active", () => {
    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).toBeNull();
    expect(screen.queryByTitle("Agent in progress")).toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).toBeNull();
  });

  it("uses resolved chat access for an Epic editor who is a chat viewer", () => {
    const handle = createHandle();
    setChatAccess(handle, "viewer");
    mockSessionState.existingHandle = handle;
    mockSessionState.epicPermissionRole = "editor";

    const { container } = renderIcon();

    expect(
      screen.getByRole("status", { name: "Read-only agent" }),
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

    expect(
      screen.queryByRole("status", { name: "Read-only agent" }),
    ).toBeNull();
    expect(container.querySelector(".lucide-message-square-lock")).toBeNull();
  });

  it("does not lock a known chat owner even when the Epic fallback is viewer", () => {
    const handle = createHandle();
    setChatAccess(handle, "owner");
    mockSessionState.existingHandle = handle;
    mockSessionState.epicPermissionRole = "viewer";

    const { container } = renderIcon();

    expect(
      screen.queryByRole("status", { name: "Read-only agent" }),
    ).toBeNull();
    expect(container.querySelector(".lucide-message-square-lock")).toBeNull();
  });

  it("uses an accessible viewer fallback for unopened chats", () => {
    mockSessionState.epicPermissionRole = "viewer";

    renderIcon();

    expect(
      screen.getByRole("status", { name: "Read-only agent" }),
    ).toBeDefined();
  });

  it("keeps the spinner visible from runStatus when awareness is missing", () => {
    const handle = createHandle();
    handle.store.setState({ runStatus: "running" });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(tooltipTextNear(screen.getByTestId(RUNNING_TEST_ID))).toBe(
      "Agent in progress",
    );
  });

  it("shows the muted background indicator instead of the turn spinner when only background work runs", () => {
    const handle = createHandle();
    handle.store.setState({
      runStatus: "running",
      turnInProgress: false,
      backgroundItems: [MONITOR_ITEM],
    });
    // Awareness reads active during background-only phases too; the session's
    // own tri-state must still win, since it sees the queue directly.
    mockSessionState.activityTiers.set(CHAT_ID, "turn");
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(
      screen.getByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeDefined();
    expect(
      screen.getByTestId(BACKGROUND_TEST_ID).getAttribute("class"),
    ).toContain("lucide-message-square-clock");
    expect(
      screen.queryByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeNull();
  });

  it("shows the background indicator for a running shell while the agent is idle", () => {
    const handle = createHandle();
    handle.store.setState({ managedCommands: [RUNNING_SHELL] });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(
      screen.getByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeDefined();
    expect(tooltipTextNear(screen.getByTestId(BACKGROUND_TEST_ID))).toBe(
      BACKGROUND_RUNNING_LABEL,
    );
    expect(
      screen.queryByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeNull();
  });

  it("keeps the static chat icon once the chat's shell has exited", () => {
    const handle = createHandle();
    handle.store.setState({
      managedCommands: [
        {
          ...RUNNING_SHELL,
          status: {
            state: "exited",
            exitCode: 0,
            signal: null,
            exitedAtMs: 2,
          },
        },
      ],
    });
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(
      screen.queryByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeNull();
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
    mockSessionState.activityTiers.set(CHAT_ID, "turn");
    mockSessionState.existingHandle = handle;

    renderIcon();

    expect(screen.queryByTestId(RUNNING_TEST_ID)).not.toBeNull();
    expect(screen.queryByTitle("Waiting for your approval")).toBeNull();
    expect(tooltipTextNear(screen.getByTestId(RUNNING_TEST_ID))).toBe(
      "Agent in progress",
    );
  });

  it("shows the background glyph for an UNOPENED chat the host reports as background-only", () => {
    // No session handle, so awareness is the only authority. Reading it as a
    // bare id set could not express this: every working chat got the turn
    // spinner, which put an unopened background-only chat at odds with the
    // calm glyph the sidebar's descendant rollup showed for that same chat.
    mockSessionState.activityTiers.set(CHAT_ID, "background");

    renderIcon();

    expect(
      screen.getByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeNull();
  });

  it("still shows the turn spinner when the host has not classified its agents", () => {
    // A host that omits the turn field leaves every working agent at "turn" -
    // the conservative pre-tier reading - so this arm must not regress into
    // presenting unclassified work as background.
    mockSessionState.activityTiers.set(CHAT_ID, "turn");

    renderIcon();

    expect(
      screen.getByRole("status", { name: TURN_RUNNING_LABEL }),
    ).toBeDefined();
    expect(
      screen.queryByRole("status", { name: BACKGROUND_RUNNING_LABEL }),
    ).toBeNull();
  });
});

function renderIcon() {
  return render(
    <ChatProgressIcon
      chatId={CHAT_ID}
      className={undefined}
      epicId={EPIC_ID}
      hostId="host-1"
      mutedClassName="text-muted-foreground"
      testId={TEST_ID}
      defaultIcon={undefined}
    />,
  );
}

function createHandle(): ChatSessionStoreHandle {
  const handle = createChatSessionStore({
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: null,
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => ({
      sendAction: () => undefined,
      sameTurnSteeringProtocolSupported: () => true,
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
