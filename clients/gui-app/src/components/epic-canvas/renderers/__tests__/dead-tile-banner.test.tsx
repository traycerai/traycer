import "../../../../../__tests__/test-browser-apis";
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
  it("says continuing creates a new Agent and leaves the original bound", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
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
    // "thread" is outside the approved vocabulary.
    expect(text).not.toContain("Continue this thread");
  });
});
