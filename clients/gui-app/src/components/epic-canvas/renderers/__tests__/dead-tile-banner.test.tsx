import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatDeadTileBanner,
  TerminalDeadTileBanner,
} from "../dead-tile-banner";

// Surfaced rather than stubbed to null: the report context is what a support
// ticket carries, and it is the one part of this banner a reader never sees on
// screen - so nothing but a test can catch it contradicting the sentence it
// sits beside.
vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: (props: {
    readonly context: {
      readonly title: string;
      readonly message: string | null;
    };
  }) => (
    <span
      data-testid="report-context"
      data-title={props.context.title}
      data-message={props.context.message ?? ""}
    />
  ),
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
        reason="host-unreachable"
        hostLabel="mac-mini"
        ownerKind="terminal"
        unavailability="offline"
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
        reason="host-unreachable"
        hostLabel="mac-mini"
        ownerKind="agent"
        unavailability="offline"
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
        reason="host-unreachable"
        hostLabel="h"
        ownerKind="agent"
        unavailability="offline"
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
        ownedByViewer
        cloneAllowed
        showsPublishedCopy={false}
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
        ownedByViewer
        cloneAllowed
        showsPublishedCopy={false}
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
        ownedByViewer
        cloneAllowed
        showsPublishedCopy={false}
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
        ownedByViewer
        cloneAllowed={false}
        showsPublishedCopy={false}
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
          ownedByViewer
          cloneAllowed
          showsPublishedCopy={false}
          cloning={false}
          onClone={() => undefined}
          testId={`chat-dead-${reason}`}
          className={undefined}
        />,
      );

      expect(screen.getByRole("status").textContent).toContain(phrase);
    },
  );

  // Shared-chat support: a collaborator's chat reaches this banner because the
  // owner's machine can never appear in the viewer's host directory - every
  // "unreachable" verdict for it is a fact about THIS account's fleet, not
  // evidence the machine is off. The pre-existing copy asserted exactly that
  // liveness ("is offline") about a raw host id, which is the misleading
  // banner this arm exists to replace.
  describe("collaborator-owned chat (ownedByViewer=false)", () => {
    it("says whose agent it is, claims no liveness, and names no host", () => {
      render(
        <ChatDeadTileBanner
          hostLabel="085b919a-f0a6-42e5-b05e-241738d3dd6a"
          reason="host-offline"
          ownedByViewer={false}
          cloneAllowed
          showsPublishedCopy
          cloning={false}
          onClone={() => undefined}
          testId="chat-dead-foreign"
          className={undefined}
        />,
      );

      const text = screen.getByTestId("chat-dead-foreign").textContent;
      expect(text).toContain("belongs to another collaborator");
      expect(text).toContain("last published copy");
      // The two claims this copy must NOT make: the machine's liveness, and
      // a host id label the reader can do nothing with.
      expect(text).not.toContain("is offline");
      expect(text).not.toContain("085b919a-f0a6-42e5-b05e-241738d3dd6a");
      // An editor keeps the way out - the host's fork path deliberately
      // permits a cross-user source in a shared epic.
      expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    });

    it("withholds Clone and says why for a view-only collaborator", () => {
      render(
        <ChatDeadTileBanner
          hostLabel="085b919a-f0a6-42e5-b05e-241738d3dd6a"
          reason="host-offline"
          ownedByViewer={false}
          cloneAllowed={false}
          showsPublishedCopy
          cloning={false}
          onClone={() => undefined}
          testId="chat-dead-foreign-viewer"
          className={undefined}
        />,
      );

      const text = screen.getByTestId("chat-dead-foreign-viewer").textContent;
      expect(text).toContain("belongs to another collaborator");
      // The reason the button is absent, in the sentence - the alternative
      // was a button whose click died on a bare "You don't have permission"
      // toast, which is the defect this gate exists to remove.
      expect(text).toContain("view-only access");
      expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    });

    // Cold-review finding: the first cut claimed "showing the last published
    // copy" unconditionally, but the live tile mounts this banner above a
    // load state or a cached live session - the claim must follow the
    // mounting surface's presentation, not the reason.
    it("claims no published copy when the mounting surface shows none", () => {
      render(
        <ChatDeadTileBanner
          hostLabel="some-host-id"
          reason="host-offline"
          ownedByViewer={false}
          cloneAllowed
          showsPublishedCopy={false}
          cloning={false}
          onClone={() => undefined}
          testId="chat-dead-foreign-no-copy"
          className={undefined}
        />,
      );

      const text = screen.getByTestId("chat-dead-foreign-no-copy").textContent;
      expect(text).toContain("belongs to another collaborator");
      expect(text).not.toContain("published copy");
      expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    });

    // Cold-review finding: `chat-not-visible` / `chat-not-on-this-host` are
    // picked only after a reachable host ANSWERED, so the foreign sentence
    // must keep the missing-history fact there - "isn't connected" would
    // invert the evidence.
    it("keeps the missing-history fact - not a connectivity claim - when a host answered", () => {
      for (const reason of [
        "chat-not-visible",
        "chat-not-on-this-host",
      ] as const) {
        const { unmount } = render(
          <ChatDeadTileBanner
            hostLabel="mac-mini"
            reason={reason}
            ownedByViewer={false}
            cloneAllowed
            showsPublishedCopy
            cloning={false}
            onClone={() => undefined}
            testId={`chat-dead-foreign-${reason}`}
            className={undefined}
          />,
        );

        const text = screen.getByTestId(
          `chat-dead-foreign-${reason}`,
        ).textContent;
        expect(text).toContain("belongs to another collaborator");
        expect(text).toContain("history isn't available");
        expect(text).not.toContain("isn't connected");
        expect(text).not.toContain("mac-mini");
        unmount();
      }
    });

    it("keeps the revoked copy for a collaborator chat - that reason is about the viewer, not a host", () => {
      render(
        <ChatDeadTileBanner
          hostLabel="mac-mini"
          reason="chat-no-longer-shared"
          ownedByViewer={false}
          cloneAllowed={false}
          showsPublishedCopy={false}
          cloning={false}
          onClone={() => undefined}
          testId="chat-dead-foreign-revoked"
          className={undefined}
        />,
      );

      const text = screen.getByTestId("chat-dead-foreign-revoked").textContent;
      expect(text).toContain("no longer shared with you");
      expect(text).not.toContain("belongs to another collaborator");
    });
  });

  // The own-chat viewer edge: a chat the viewer created before their role was
  // downgraded. The reason copy still ends in "clone it and carry on", so the
  // button's absence must be explained rather than silent.
  it("withholds Clone on the viewer's own chat when the role can't create agents, and says why", () => {
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="host-offline"
        ownedByViewer
        cloneAllowed={false}
        showsPublishedCopy={false}
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead-own-viewer"
        className={undefined}
      />,
    );

    const text = screen.getByTestId("chat-dead-own-viewer").textContent;
    expect(text).toContain("is offline");
    expect(text).toContain("view-only access");
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
  });

  // Every clone-offering sentence ENDS in the promise ("continuing here creates
  // a new agent", "cloning creates a new agent from it"). Appending the denial
  // to one of those produced a banner that offered and refused the same action
  // in consecutive sentences, so the no-clone variant must not carry it at all.
  it("never promises cloning in the same breath as refusing it", () => {
    for (const reason of [
      "host-offline",
      "host-plan-restricted",
      "chat-not-visible",
      "chat-not-on-this-host",
    ] as const) {
      const { unmount } = render(
        <ChatDeadTileBanner
          hostLabel="mac-mini"
          reason={reason}
          ownedByViewer
          cloneAllowed={false}
          showsPublishedCopy={false}
          cloning={false}
          onClone={() => undefined}
          testId={`chat-dead-no-clone-${reason}`}
          className={undefined}
        />,
      );

      const text = screen.getByTestId(
        `chat-dead-no-clone-${reason}`,
      ).textContent;
      expect(text).toContain("view-only access");
      expect(text).not.toContain("creates a new agent");
      expect(text).not.toContain("cloning creates");
      expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
      unmount();
    }
  });

  // The report rides along invisibly, so it can drift from the sentence
  // without anyone noticing. For the two reasons a host ANSWERED on, claiming
  // a disconnected host would file a ticket contradicting the screen.
  it("files a foreign-owner report that matches the reason on screen", () => {
    for (const reason of [
      "chat-not-visible",
      "chat-not-on-this-host",
    ] as const) {
      const { unmount } = render(
        <ChatDeadTileBanner
          hostLabel="mac-mini"
          reason={reason}
          ownedByViewer={false}
          cloneAllowed
          showsPublishedCopy
          cloning={false}
          onClone={() => undefined}
          testId={`chat-dead-report-${reason}`}
          className={undefined}
        />,
      );

      const report = screen.getByTestId("report-context");
      expect(report.getAttribute("data-message")).not.toContain(
        "isn't connected",
      );
      expect(report.getAttribute("data-message")).toContain("history");
      unmount();
    }

    // The unreachable arm keeps the connectivity claim, which is true there.
    render(
      <ChatDeadTileBanner
        hostLabel="mac-mini"
        reason="host-offline"
        ownedByViewer={false}
        cloneAllowed
        showsPublishedCopy
        cloning={false}
        onClone={() => undefined}
        testId="chat-dead-report-offline"
        className={undefined}
      />,
    );
    expect(
      screen.getByTestId("report-context").getAttribute("data-message"),
    ).toContain("isn't connected here");
  });
});
