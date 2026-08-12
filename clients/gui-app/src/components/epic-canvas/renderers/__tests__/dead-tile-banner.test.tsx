import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatDeadTileBanner,
  TerminalDeadTileBanner,
} from "../dead-tile-banner";

vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));

afterEach(cleanup);

/**
 * `TerminalDeadTileBanner` is shared by two owners with OPPOSITE durability
 * semantics, so the copy is owner-aware rather than one shared string:
 *
 *   - a raw Terminal really is gone when its Host goes away
 *   - an Agent on the Terminal interface is durable and returns with its Host
 *
 * Telling an Agent's owner the session is "permanently closed" would say the
 * opposite of the Edge-state contract, so each variant is pinned here.
 */
describe("<TerminalDeadTileBanner />", () => {
  it("tells a raw Terminal owner the session is permanently gone", () => {
    render(
      <TerminalDeadTileBanner
        hostLabel="mac-mini"
        ownerKind="terminal"
        onClose={() => undefined}
        testId="terminal-tile-1"
      />,
    );

    expect(screen.getByTestId("terminal-tile-1").textContent).toContain(
      "This terminal is permanently closed.",
    );
  });

  it("tells a Terminal-interface Agent owner the Agent survives its Host", () => {
    render(
      <TerminalDeadTileBanner
        hostLabel="mac-mini"
        ownerKind="agent"
        onClose={() => undefined}
        testId="terminal-agent-tile-1"
      />,
    );

    const text = screen.getByTestId("terminal-agent-tile-1").textContent;
    // Unavailable until the Host returns - not destroyed.
    expect(text).toContain("unavailable until that host is back");
    expect(text).toContain("agent and its transcript are kept");
    // Closing the tab must not read as deleting the Agent.
    expect(text).toContain("only removes it from the canvas");
    expect(text).not.toContain("permanently closed");
  });

  it("keeps the close action available on both variants", () => {
    render(
      <TerminalDeadTileBanner
        hostLabel="h"
        ownerKind="agent"
        onClose={() => undefined}
        testId="t-agent"
      />,
    );
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
  });
});

describe("<ChatDeadTileBanner />", () => {
  it("says continuing creates a new Agent and leaves the original bound (host-offline)", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="host-offline"
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead"
        className={undefined}
      />,
    );

    const text = screen.getByTestId("chat-dead").textContent;
    // The clone fires immediately from this banner, so it is the only place the
    // user is told two Agents now exist.
    expect(text).toContain("creates a new agent on the active host");
    expect(text).toContain("this one stays bound to");
    expect(text).toContain("is offline");
    // "thread" is outside the approved vocabulary.
    expect(text).not.toContain("Continue this thread");
  });

  // ticket 35: a reachable host can still have nothing to serve for this
  // chat (`chat.subscribe` terminated CHAT_NOT_VISIBLE) - "is offline" would
  // be false here, so this variant must say something else while keeping
  // the same Clone offer and two-Agents disclosure.
  it("does NOT claim the host is offline when the chat itself is confirmed absent", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="chat-not-visible"
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead-absent"
        className={undefined}
      />,
    );

    const text = screen.getByTestId("chat-dead-absent").textContent;
    expect(text).toContain("creates a new agent on the active host");
    expect(text).toContain("this one stays bound to");
    expect(text).not.toContain("is offline");
    expect(text).toContain("history isn't available");
    // ...and it is still talking about ANOTHER machine, which is the whole
    // reason the same-host case below cannot reuse it.
    expect(text).toContain("mac-mini");
  });

  // tickets 47/48: the same "not here" answer, from the host this device is
  // CONNECTED to. Both sentences above would print the reader's own machine
  // as somewhere their history is unavailable / stays bound to - the copy
  // that sent two live debugging sessions after a healthy host on
  // 2026-08-11. This variant names no host and promises no return, because
  // the host already answered.
  it("names no host, and no bound-host disclosure, when this device's own host answered that the chat is not here", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="chat-not-on-this-host"
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead-here"
        className={undefined}
      />,
    );

    const text = screen.getByTestId("chat-dead-here").textContent;
    expect(text).toContain("no longer on this host");
    expect(text).not.toContain("mac-mini");
    expect(text).not.toContain("is offline");
    expect(text).not.toContain("stays bound to");
    // The published copy is named, so the reader knows what they are reading.
    expect(text).toContain("last published copy");
    // The Clone offer survives the reword - a copy with no way forward is
    // what this banner exists to avoid.
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
  });

  // The banner appears (and swaps between reasons) mid-session with no focus
  // move, and WHICH of the three truths is on screen lives only in this
  // sentence. A state a screen reader is never told about is a state that
  // does not exist for that reader - so the copy has to reach the accessible
  // tree as a live region, not just as pixels.
  // multi-host-chats record layer: the taxonomy's final member. The only one
  // that is not about a HOST at all - the chat exists, its host is fine, and
  // what changed is this viewer's entitlement. Naming a host here would send
  // the reader to inspect a perfectly healthy machine.
  it("says the agent is no longer shared, names no host, and offers no clone", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="chat-no-longer-shared"
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead-revoked"
        className={undefined}
      />,
    );

    const banner = screen.getByTestId("chat-dead-revoked");
    const text = banner.textContent;
    expect(text).toContain("no longer shared with you");
    expect(text).not.toContain("mac-mini");
    expect(text).not.toContain("is offline");
    expect(text).not.toContain("stays bound to");
    // Every OTHER reason ends in "clone it and carry on". This one cannot: the
    // clone would have to read a transcript the server just stopped serving
    // this viewer, so the button would be an invitation to a failure.
    // Ablation: render the Clone button unconditionally and this goes red.
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    // The reason still reaches the DOM for the canvas tests to key on.
    expect(banner.getAttribute("data-reason")).toBe("chat-no-longer-shared");
  });

  it.each([
    ["host-offline", "is offline"],
    ["chat-not-visible", "history isn't available"],
    ["chat-not-on-this-host", "no longer on this host"],
    ["chat-no-longer-shared", "no longer shared with you"],
  ] as const)(
    "exposes the %s state through an announced live region",
    (reason, phrase) => {
      render(
        <ChatDeadTileBanner
          hostLabel="mac-mini"
          reason={reason}
          cloning={false}
          onClone={() => undefined}
          testId={`chat-dead-${reason}`}
          className={undefined}
        />,
      );

      expect(screen.getByRole("status").textContent).toContain(phrase);
    },
  );
});
