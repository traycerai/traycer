import "../../../../../__tests__/test-browser-apis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

interface HeaderTestState {
  chats: { byId: Record<string, { readonly title: string }> };
  tuiAgents: { byId: Record<string, { readonly title: string }> };
}

const testState = vi.hoisted<HeaderTestState>(() => ({
  chats: { byId: {} },
  tuiAgents: { byId: {} },
}));

// The header is the only part of the modal under test; the surrounding modal
// pulls in the whole composer (host client, Query, worktree stores), so the
// epic projection is the single seam faked here.
vi.mock("@/hooks/use-epic-store", () => ({
  useEpicStore: (selector: (state: HeaderTestState) => unknown) =>
    selector(testState),
}));

const { NewConversationModalHeader } =
  await import("../new-conversation-modal");

afterEach(() => {
  cleanup();
  testState.chats = { byId: {} };
  testState.tuiAgents = { byId: {} };
});

describe("<NewConversationModalHeader />", () => {
  it("names the durable Agent, with the interface as secondary context", () => {
    render(
      <NewConversationModalHeader
        composerMode="chat"
        parentId={null}
        switcher={null}
      />,
    );

    expect(screen.getByText("Start a new agent")).not.toBeNull();
    expect(screen.getByText("Chat interface")).not.toBeNull();
  });

  it("keeps the same Agent title when the Terminal interface is selected", () => {
    render(
      <NewConversationModalHeader
        composerMode="terminal"
        parentId={null}
        switcher={null}
      />,
    );

    // The interface choice must not change what is being created.
    expect(screen.getByText("Start a new agent")).not.toBeNull();
    expect(screen.getByText("Terminal interface")).not.toBeNull();
  });

  it("names the parent Agent and the interface when adding a child", () => {
    testState.chats = { byId: { "parent-1": { title: "Planning" } } };

    render(
      <NewConversationModalHeader
        composerMode="terminal"
        parentId="parent-1"
        switcher={null}
      />,
    );

    expect(
      screen.getByText("Child agent of Planning · Terminal interface"),
    ).not.toBeNull();
  });

  it("resolves a terminal-interface parent from the tui projection slice", () => {
    testState.tuiAgents = { byId: { "parent-2": { title: "Refactor run" } } };

    render(
      <NewConversationModalHeader
        composerMode="chat"
        parentId="parent-2"
        switcher={null}
      />,
    );

    expect(
      screen.getByText("Child agent of Refactor run · Chat interface"),
    ).not.toBeNull();
  });

  it("falls back to 'Untitled agent' for an untitled parent on either interface", () => {
    testState.chats = { byId: { "parent-1": { title: "" } } };

    render(
      <NewConversationModalHeader
        composerMode="chat"
        parentId="parent-1"
        switcher={null}
      />,
    );

    // Interface-agnostic fallback: the parent is an Agent, not a "chat".
    expect(
      screen.getByText("Child agent of Untitled agent · Chat interface"),
    ).not.toBeNull();
  });
});
