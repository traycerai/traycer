import "../../../../../../__tests__/test-browser-apis";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TerminalQuoteControl } from "../terminal-quote-control";
import type { TerminalQuoteChatTarget } from "../terminal-quote-targets";

const ANCHOR = { top: 120, placement: "above" } as const;

afterEach(() => {
  cleanup();
});

// The menu is controlled by the overlay in production; own that state here
// too, so opening it goes through the same path.
function ControlHarness(props: {
  readonly targets: ReadonlyArray<TerminalQuoteChatTarget>;
  readonly onQuoteToChat: (chatId: string) => void;
  readonly onQuoteToNewChat: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <TerminalQuoteControl
      anchor={ANCHOR}
      targets={props.targets}
      onQuoteToChat={props.onQuoteToChat}
      onQuoteToNewChat={props.onQuoteToNewChat}
      menuOpen={menuOpen}
      onMenuOpenChange={setMenuOpen}
    />
  );
}

function renderControl(targets: ReadonlyArray<TerminalQuoteChatTarget>) {
  const onQuoteToChat = vi.fn();
  const onQuoteToNewChat = vi.fn();
  render(
    <ControlHarness
      targets={targets}
      onQuoteToChat={onQuoteToChat}
      onQuoteToNewChat={onQuoteToNewChat}
    />,
  );
  return { onQuoteToChat, onQuoteToNewChat };
}

describe("TerminalQuoteControl", () => {
  it("names the target chat on the primary action", async () => {
    const { onQuoteToChat } = renderControl([
      { chatId: "chat-1", title: "Kickoff", isLastFocused: true },
      { chatId: "chat-2", title: "Docs", isLastFocused: false },
    ]);

    // "Where is this going" is answered on the button, not behind a hover.
    const primary = screen.getByRole("button", { name: "Quote into Kickoff" });
    expect(primary.textContent).toContain("Kickoff");

    await userEvent.click(primary);
    expect(onQuoteToChat).toHaveBeenCalledWith("chat-1");
  });

  it("offers a new chat as the primary action when the Task has none", async () => {
    const { onQuoteToNewChat, onQuoteToChat } = renderControl([]);

    await userEvent.click(
      screen.getByRole("button", { name: "Quote into a new chat" }),
    );

    expect(onQuoteToNewChat).toHaveBeenCalledOnce();
    expect(onQuoteToChat).not.toHaveBeenCalled();
  });

  it("keeps every chat and a new-chat escape hatch behind the split", async () => {
    const { onQuoteToChat } = renderControl([
      { chatId: "chat-1", title: "Kickoff", isLastFocused: true },
      { chatId: "chat-2", title: "Docs", isLastFocused: false },
    ]);

    await userEvent.click(
      screen.getByRole("button", { name: "Choose where to quote" }),
    );

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["KickoffLast used", "Docs", "New chat"]);

    await userEvent.click(screen.getByRole("menuitem", { name: /Docs/ }));
    expect(onQuoteToChat).toHaveBeenCalledWith("chat-2");
  });

  it("does not take focus from the terminal when pressed", () => {
    renderControl([
      { chatId: "chat-1", title: "Kickoff", isLastFocused: true },
    ]);
    const primary = screen.getByRole("button", { name: "Quote into Kickoff" });

    // A focus grab here would collapse the very selection being quoted.
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    primary.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
  });
});
