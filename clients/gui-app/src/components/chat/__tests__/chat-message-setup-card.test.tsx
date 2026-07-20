import "../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage as ChatMessageModel } from "@/stores/composer/chat-store";
import type { SetupCardViewModel } from "@/components/chat/segments/setup-card-segment";

// Stub the card so the routing branch is exercised without the card's
// host/query/terminal-liveness plumbing (that surface is covered by
// setup-card-segment.test.tsx). The stub echoes the props the branch must pass
// straight through.
vi.mock("../segments/setup-card-segment", () => ({
  SetupCardSegment: (props: {
    model: SetupCardViewModel;
    viewTabId: string;
  }) => (
    <output
      aria-label="setup card"
      data-view-tab={props.viewTabId}
      data-state={props.model.aggregate.state}
    />
  ),
}));

vi.mock("../segments/forked-chat-link-segment", () => ({
  ForkedChatLinkSegment: (props: {
    viewTabId: string;
    sourceChatId: string;
    sourceChatTitle: string;
    sourceHostId: string;
  }) => (
    <button
      type="button"
      aria-label={`Open source conversation ${props.sourceChatTitle}`}
      data-view-tab={props.viewTabId}
      data-source-chat={props.sourceChatId}
      data-source-title={props.sourceChatTitle}
      data-source-host={props.sourceHostId}
    />
  ),
}));

import { ChatMessage } from "@/components/chat/chat-message";

const EMPTY_BACKGROUND_TOOL_BLOCK_IDS: ReadonlySet<string> = new Set();

const SETUP_MODEL: SetupCardViewModel = {
  aggregate: {
    epicId: "epic-1",
    ownerId: "owner-1",
    ownerKind: "chat",
    state: "setting-up",
  },
  workspaces: [
    {
      workspacePath: "/repo",
      label: "repo",
      state: "setting-up",
      setupExitCode: null,
      terminalSessionId: "term-1",
      worktreePath: "/worktrees/repo/feature",
      branch: "feature",
      errorMessage: null,
      retryFolderIntent: null,
    },
  ],
  createdAt: 1500,
  isActive: true,
};

function setupCardRow(): ChatMessageModel {
  return {
    id: "setup-card:owner-1:0:1500",
    role: "system",
    content: "",
    segments: [
      {
        id: "setup-card:owner-1:0:1500:card",
        kind: "setup-card",
        model: SETUP_MODEL,
        viewTabId: "tab-1",
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 1500,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

function forkedChatLinkRow(): ChatMessageModel {
  return {
    id: "forked-chat-link:event-1",
    role: "system",
    content: "",
    segments: [
      {
        id: "forked-chat-link:event-1:link",
        kind: "forked-chat-link",
        viewTabId: "tab-1",
        sourceChatId: "source-chat-1",
        sourceChatTitle: "Original chat",
        sourceHostId: "source-host-1",
      },
    ],
    structuredContent: null,
    attachments: [],
    settings: null,
    createdAt: 2500,
    completedAt: null,
    stopped: null,
    persistentMessageId: null,
    senderLabel: null,
    assistantMeta: null,
    statusLabel: null,
    agentSenderInfo: null,
    agentMessage: null,
    runState: null,
    sessionAnchor: null,
    steerBadge: null,
  };
}

describe("<ChatMessage /> setup-card routing", () => {
  afterEach(() => {
    cleanup();
  });

  it("routes a setup-card row to the card, passing the segment's viewTabId", () => {
    render(
      <ChatMessage
        message={setupCardRow()}
        actions={null}
        backgroundToolBlockIds={EMPTY_BACKGROUND_TOOL_BLOCK_IDS}
        nextStepActions={null}
      />,
    );

    const card = screen.getByRole("status", { name: "setup card" });
    expect(card.getAttribute("data-view-tab")).toBe("tab-1");
    expect(card.getAttribute("data-state")).toBe("setting-up");
    // No "SYSTEM" sender label and no centered system treatment for the card.
    expect(screen.queryByText("SYSTEM")).toBeNull();
  });

  it("routes a forked-chat-link row to the fork link segment", () => {
    render(
      <ChatMessage
        message={forkedChatLinkRow()}
        actions={null}
        backgroundToolBlockIds={EMPTY_BACKGROUND_TOOL_BLOCK_IDS}
        nextStepActions={null}
      />,
    );

    const link = screen.getByRole("button", {
      name: "Open source conversation Original chat",
    });
    expect(link.getAttribute("data-view-tab")).toBe("tab-1");
    expect(link.getAttribute("data-source-chat")).toBe("source-chat-1");
    expect(link.getAttribute("data-source-title")).toBe("Original chat");
    expect(link.getAttribute("data-source-host")).toBe("source-host-1");
    expect(screen.queryByText("SYSTEM")).toBeNull();
  });
});
