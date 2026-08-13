import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatUserMessageContent } from "@/components/chat/chat-user-message-content";
import { tooltipTextNear } from "@/components/ui/__tests__/tooltip-probe";
import type { MentionAttachment } from "@/lib/composer/types";

afterEach(() => {
  cleanup();
});

/**
 * A GitHub mention attachment as the composer builds it. `path` is a synthetic
 * token rather than a filesystem path - which is the whole reason the sent
 * message needs its own branch: the generic chip reads a basename off `path`
 * and shows `absolutePath ?? path` as the tooltip, so this attachment would
 * render as `traycer#4917` with the raw `github-pr:` token hanging off it.
 */
function pullRequestMention(): MentionAttachment {
  return {
    kind: "mention",
    contextType: "github_pull_request",
    path: "github-pr:traycerai/traycer#4917",
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: "#4917",
    description: "traycerai/traycer#4917 · Stop the busy-loop",
    githubHost: "github.com",
    organizationLogin: "traycerai",
    repositoryName: "traycer",
    issueNumber: 4917,
    url: "https://github.com/traycerai/traycer/pull/4917",
  };
}

/**
 * Written out rather than spread over the pull-request fixture: `contextType`
 * is the union's discriminant, and overriding it through a spread widens the
 * result instead of narrowing it to the issue arm.
 */
function issueMention(): MentionAttachment {
  return {
    kind: "mention",
    contextType: "github_issue",
    path: "github-issue:traycerai/traycer#812",
    pathKind: null,
    relPath: null,
    absolutePath: null,
    workspacePath: null,
    label: "traycer#812",
    description: "traycerai/traycer#812 · Magic link expires",
    githubHost: "github.com",
    organizationLogin: "traycerai",
    repositoryName: "traycer",
    issueNumber: 812,
    url: "https://github.com/traycerai/traycer/issues/812",
  };
}

describe("ChatUserMessageContent GitHub chips", () => {
  it("keeps the composer's label and title tooltip after the message is sent", () => {
    render(
      <ChatUserMessageContent
        content="Look at @github-pr:traycerai/traycer#4917 before merging."
        attachments={[pullRequestMention()]}
      />,
    );

    const chip = screen.getByText("#4917");
    expect(chip).toBeTruthy();
    // The tooltip carries the title, not the token: a reader hovering a sent
    // chip is asking what it refers to, and the raw path answers nothing.
    //
    // Asserted by OPENING it. "the token does not appear" passes just as well
    // when the tooltip is empty, or gone - the generic branch this chip exists
    // to avoid would satisfy it too, since that renders the token as a `title`
    // attribute rather than as text.
    expect(tooltipTextNear(chip)).toBe(
      "traycerai/traycer#4917 · Stop the busy-loop",
    );
    expect(screen.queryByText("github-pr:traycerai/traycer#4917")).toBeNull();
    expect(
      document.querySelector("[data-composer-chip='mention']"),
    ).toBeTruthy();
  });

  it("labels an issue chip from the attachment rather than its token basename", () => {
    render(
      <ChatUserMessageContent
        content="Fixed by @github-issue:traycerai/traycer#812"
        attachments={[issueMention()]}
      />,
    );

    // `traycer#812` is the multi-repository label the composer chose. The
    // basename of the token happens to read the same way, so the label alone
    // cannot tell the two branches apart - the tooltip can, and it is the
    // thing a reader actually consults.
    const chip = screen.getByText("traycer#812");
    expect(chip).toBeTruthy();
    expect(tooltipTextNear(chip)).toBe(
      "traycerai/traycer#812 · Magic link expires",
    );
    expect(screen.queryByText("github-issue:traycerai/traycer#812")).toBeNull();
  });
});
