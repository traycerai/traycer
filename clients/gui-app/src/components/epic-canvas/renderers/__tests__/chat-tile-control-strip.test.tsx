import "../../../../../__tests__/test-browser-apis";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type {
  ChatQueuedItem,
  ChatQueuedManagedCommandItem,
  ChatQueuedPromptItem,
  ChatRunSettings,
} from "@traycer/protocol/host/agent/gui/subscribe";
import type { ChatSessionState } from "@/stores/chats/chat-session-store";
import { ChatControlStrip } from "../chat-tile-control-strip";

const SETTINGS: ChatRunSettings = {
  harnessId: "codex",
  model: "codex-test",
  permissionMode: "supervised",
  reasoningEffort: "medium",
  serviceTier: null,
  agentMode: "epic",
  profileId: null,
};

describe("<ChatControlStrip /> queue rows", () => {
  afterEach(() => {
    cleanup();
  });

  it("marks a managed-command row with the dock's provenance badge and cancel copy", () => {
    renderStrip([
      promptItem("queue-prompt", "First queued prompt"),
      managedCommandItem("queue-managed", "bun test --watch"),
    ]);

    const managedRow = screen.getAllByTestId("queue-panel-row")[1];
    const badge = within(managedRow).getByTestId(
      "queued-managed-command-badge",
    );
    expect(badge.textContent).toContain("Command output");
    expect(badge.getAttribute("title")).toBe(
      "Output from a background command, delivered to the agent when this runs",
    );
    expect(within(managedRow).getByText("bun test --watch")).not.toBeNull();

    expect(
      within(managedRow).getByRole("button", {
        name: "Cancel queued command output",
      }),
    ).not.toBeNull();
    expect(
      within(managedRow).queryByRole("button", {
        name: "Cancel queued prompt",
      }),
    ).toBeNull();
  });

  it("names the reorder actions after the managed-command row's own kind", () => {
    renderStrip([
      promptItem("queue-prompt", "First queued prompt"),
      managedCommandItem("queue-managed", "bun test --watch"),
    ]);

    const managedRow = screen.getAllByTestId("queue-panel-row")[1];
    expect(
      within(managedRow).getByRole("button", {
        name: "Move queued command output up",
      }),
    ).not.toBeNull();
    expect(
      within(managedRow).getByRole("button", {
        name: "Move queued command output down",
      }),
    ).not.toBeNull();
  });

  it("leaves a prompt row on the prompt copy with no provenance badge", () => {
    renderStrip([
      promptItem("queue-prompt", "First queued prompt"),
      managedCommandItem("queue-managed", "bun test --watch"),
    ]);

    const promptRow = screen.getAllByTestId("queue-panel-row")[0];
    expect(
      within(promptRow).queryByTestId("queued-managed-command-badge"),
    ).toBeNull();
    expect(
      within(promptRow).getByRole("button", { name: "Cancel queued prompt" }),
    ).not.toBeNull();
    expect(
      within(promptRow).getByRole("button", { name: "Move queued prompt up" }),
    ).not.toBeNull();
    expect(
      within(promptRow).getByRole("button", {
        name: "Move queued prompt down",
      }),
    ).not.toBeNull();
    expect(
      within(promptRow).queryByRole("button", {
        name: "Cancel queued command output",
      }),
    ).toBeNull();
  });
});

function renderStrip(items: ReadonlyArray<ChatQueuedItem>) {
  const state: Pick<ChatSessionState, "queue"> = {
    queue: { status: "idle", items: [...items] },
  };
  return render(
    <ChatControlStrip
      state={state}
      canAct
      editingQueueItemId={null}
      onQueuePause={() => null}
      onResumeQueue={() => null}
      onQueueEdit={() => undefined}
      onQueueCancel={() => undefined}
      onQueueReorder={() => undefined}
    />,
  );
}

function promptItem(queueItemId: string, text: string): ChatQueuedPromptItem {
  return {
    kind: "prompt",
    queueItemId,
    messageId: `${queueItemId}-message`,
    message: { kind: "user", content: content(text) },
    sender: { type: "user", userId: "owner-1" },
    settings: SETTINGS,
    accountContext: { type: "PERSONAL" as const },
    delivery: "next_turn",
    status: "pending",
    targetTurnId: null,
    steerRequest: null,
    fallbackReason: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function managedCommandItem(
  queueItemId: string,
  description: string,
): ChatQueuedManagedCommandItem {
  return {
    kind: "managed-command",
    queueItemId,
    commandId: `${queueItemId}-command`,
    description,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
  };
}

function content(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}
