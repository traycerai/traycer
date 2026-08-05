import "../../../../../../__tests__/test-browser-apis";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TerminalQuoteControl } from "../terminal-quote-control";
import type { TerminalQuoteChatTarget } from "../terminal-quote-targets";

const ANCHOR = {
  top: 120,
  left: 240,
  maxWidth: 400,
  placement: "above",
} as const;

afterEach(() => {
  cleanup();
});

function target(fields: {
  chatId: string;
  title: string;
  isOpen: boolean;
  isLastFocused: boolean;
}): TerminalQuoteChatTarget {
  return { ...fields, isOnOtherHost: false };
}

// The menu is controlled by the overlay in production; own that state here
// too, so opening it goes through the same path.
function ControlHarness(props: {
  readonly targets: ReadonlyArray<TerminalQuoteChatTarget>;
  readonly onSendToChat: (chatId: string) => void;
  readonly onSendToNewChat: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <TerminalQuoteControl
      anchor={ANCHOR}
      targets={props.targets}
      onSendToChat={props.onSendToChat}
      onSendToNewChat={props.onSendToNewChat}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
    />
  );
}

function renderControl(targets: ReadonlyArray<TerminalQuoteChatTarget>) {
  const onSendToChat = vi.fn();
  const onSendToNewChat = vi.fn();
  render(
    <ControlHarness
      targets={targets}
      onSendToChat={onSendToChat}
      onSendToNewChat={onSendToNewChat}
    />,
  );
  return { onSendToChat, onSendToNewChat };
}

async function openPanel(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Send to chat" }));
}

describe("TerminalQuoteControl", () => {
  it("offers one action, which opens the chat list", async () => {
    const { onSendToChat, onSendToNewChat } = renderControl([
      target({
        chatId: "chat-1",
        title: "Kickoff",
        isOpen: true,
        isLastFocused: true,
      }),
    ]);

    // No primary target on the button: pressing it asks where, never guesses.
    expect(screen.queryByRole("menuitem")).toBeNull();
    await openPanel();

    expect(onSendToChat).not.toHaveBeenCalled();
    expect(onSendToNewChat).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["KickoffLast used", "New chat"]);
  });

  it("bands open chats above the rest, and heads each band", async () => {
    const { onSendToChat } = renderControl([
      target({
        chatId: "chat-1",
        title: "Kickoff",
        isOpen: true,
        isLastFocused: true,
      }),
      target({
        chatId: "chat-2",
        title: "Docs",
        isOpen: false,
        isLastFocused: false,
      }),
    ]);

    await openPanel();

    expect(screen.getByText("Open")).toBeTruthy();
    expect(screen.getByText("Other chats")).toBeTruthy();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["KickoffLast used", "Docs", "New chat"]);

    await userEvent.click(screen.getByRole("menuitem", { name: /Docs/ }));
    expect(onSendToChat).toHaveBeenCalledWith("chat-2");
  });

  it("drops the headings when there is only one band to head", async () => {
    renderControl([
      target({
        chatId: "chat-1",
        title: "Kickoff",
        isOpen: true,
        isLastFocused: false,
      }),
      target({
        chatId: "chat-2",
        title: "Docs",
        isOpen: true,
        isLastFocused: false,
      }),
    ]);

    await openPanel();

    expect(screen.queryByText("Open")).toBeNull();
    expect(screen.queryByText("Other chats")).toBeNull();
  });

  it("keeps New chat reachable when the Task has no chats", async () => {
    const { onSendToNewChat } = renderControl([]);

    await openPanel();
    await userEvent.click(screen.getByRole("menuitem", { name: "New chat" }));

    expect(onSendToNewChat).toHaveBeenCalledOnce();
  });

  it("offers a chat on another host as an unpickable row with the reason", async () => {
    const { onSendToChat, onSendToNewChat } = renderControl([
      {
        ...target({
          chatId: "chat-here",
          title: "Kickoff",
          isOpen: false,
          isLastFocused: false,
        }),
      },
      {
        ...target({
          chatId: "chat-elsewhere",
          title: "Refactor",
          isOpen: false,
          isLastFocused: true,
        }),
        isOnOtherHost: true,
      },
    ]);

    await openPanel();
    const elsewhere = screen.getByRole("menuitem", { name: /Refactor/ });

    // The reason replaces "Last used" - why it cannot be picked is what the
    // row owes the user.
    expect(elsewhere.textContent).toBe("RefactorOn a different host");
    expect(elsewhere.getAttribute("data-disabled")).not.toBeNull();

    await userEvent.click(elsewhere);
    expect(onSendToChat).not.toHaveBeenCalled();

    // The rest of the panel is untouched by one dead row.
    await userEvent.click(screen.getByRole("menuitem", { name: "Kickoff" }));
    expect(onSendToChat).toHaveBeenCalledWith("chat-here");
    expect(onSendToNewChat).not.toHaveBeenCalled();
  });

  it("skips a different-host row when arrowing through the panel", async () => {
    renderControl([
      {
        ...target({
          chatId: "chat-elsewhere",
          title: "Refactor",
          isOpen: false,
          isLastFocused: false,
        }),
        isOnOtherHost: true,
      },
      target({
        chatId: "chat-here",
        title: "Kickoff",
        isOpen: false,
        isLastFocused: false,
      }),
    ]);

    await openPanel();
    await userEvent.keyboard("{ArrowDown}");

    // Radix's own `disabled` owns the skip, so the keyboard cannot reach what
    // the pointer cannot either.
    expect(screen.getByRole("menuitem", { name: "Kickoff" })).toBe(
      document.activeElement,
    );
  });

  it("pins New chat below the scrolling roster", async () => {
    renderControl(
      Array.from({ length: 30 }, (_, index) =>
        target({
          chatId: `chat-${index}`,
          title: `Agent ${index}`,
          isOpen: false,
          isLastFocused: false,
        }),
      ),
    );

    await openPanel();
    const newChat = screen.getByRole("menuitem", { name: "New chat" });
    const roster = screen.getByRole("menuitem", {
      name: "Agent 0",
    }).parentElement;

    // The roster scrolls; the action below it is a sibling, so a long list
    // cannot push it out of reach.
    expect(roster?.className).toContain("overflow-y-auto");
    expect(roster?.contains(newChat)).toBe(false);
  });
});
