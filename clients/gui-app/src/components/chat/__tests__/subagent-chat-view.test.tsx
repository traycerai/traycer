import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExpansionTestProviders } from "@/components/chat/__tests__/chat-expansion-test-providers";
import { makeMessage } from "@/components/chat/__tests__/chat-message-fixtures";
import { subagentCardPath } from "@/components/chat/segments/subagent-display";
import type { SubagentDrillIn } from "@/components/chat/segments/subagent-open-as-chat";
import { SubagentChatView } from "@/components/chat/subagent-chat-view";
import type {
  ChatMessage as ChatMessageModel,
  SubagentChildSegment,
  SubagentSegment,
} from "@/stores/composer/chat-store";

function card(
  id: string,
  name: string,
  children: ReadonlyArray<SubagentChildSegment>,
): SubagentSegment {
  return {
    id,
    kind: "subagent",
    name,
    agentType: null,
    task: `${name} task`,
    progressUpdates: [],
    result: null,
    isStreaming: false,
    endState: null,
    stopped: false,
    startedAt: null,
    durationMs: null,
    spawnToolCallId: null,
    parentId: null,
    workflowMeta: null,
    children,
  };
}

function messagesWithNestedCards(): ReadonlyArray<ChatMessageModel> {
  const leaf = card("leaf", "leaf-agent", [
    {
      id: "leaf-text",
      kind: "text",
      markdown: "leaf words",
      isStreaming: false,
      parentId: "leaf",
    },
  ]);
  const root = card("root", "root-agent", [
    {
      id: "root-text",
      kind: "text",
      markdown: "root words",
      isStreaming: false,
      parentId: "root",
    },
    leaf,
  ]);
  return [{ ...makeMessage(1, "assistant"), segments: [root] }];
}

function renderView(openId: string | null, handlers: SubagentDrillIn) {
  return render(
    <ChatExpansionTestProviders tileInstanceId="subagent-chat-view-tile">
      <SubagentChatView
        drillIn={{ ...handlers, openId }}
        messages={messagesWithNestedCards()}
        bottomInset={0}
      />
    </ChatExpansionTestProviders>,
  );
}

describe("subagentCardPath", () => {
  it("returns the ancestor chain for a nested card and null for an unknown id", () => {
    const messages = messagesWithNestedCards();
    expect(subagentCardPath(messages, "leaf")?.map((c) => c.id)).toEqual([
      "root",
      "leaf",
    ]);
    expect(subagentCardPath(messages, "root")?.map((c) => c.id)).toEqual([
      "root",
    ]);
    expect(subagentCardPath(messages, "missing")).toBeNull();
  });
});

describe("<SubagentChatView />", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the breadcrumb, the task and the conversation for an open card", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("root", { openId: "root", open, close });

    expect(screen.getByTestId("subagent-chat-back")).toBeTruthy();
    expect(screen.getAllByText("root-agent").length).toBeGreaterThan(0);
    expect(screen.getByText("root-agent task")).toBeTruthy();
    expect(screen.getByText("root words")).toBeTruthy();
  });

  it("calls close from the back button", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("root", { openId: "root", open, close });

    fireEvent.click(screen.getByTestId("subagent-chat-back"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("opens the ancestor when its crumb is clicked", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("leaf", { openId: "leaf", open, close });

    expect(screen.getByText("leaf words")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "root-agent" }));
    expect(open).toHaveBeenCalledWith("root");
  });

  it("says the subagent left the loaded transcript for an unknown id", () => {
    const open = vi.fn();
    const close = vi.fn();
    renderView("missing", { openId: "missing", open, close });

    expect(
      screen.getByText("This subagent is no longer in the loaded transcript."),
    ).toBeTruthy();
  });
});
