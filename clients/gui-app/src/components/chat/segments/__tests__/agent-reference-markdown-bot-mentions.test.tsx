/**
 * A bot channel's message text through the REAL markdown path
 * (`AgentReferenceMarkdown` over `TraycerMarkdown`): a `<@userId>` token is
 * the member's chip where `BotMentionsContext` names them, and the token as
 * written otherwise.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BotMentionsContext,
  type BotMentioned,
} from "@/components/bots/bot-mentions-context";
import { AgentReferenceMarkdown } from "@/components/chat/segments/agent-reference-markdown";

const VIEWER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const ANN = "user-ann";
const STRANGER = "user-stranger";

const MEMBERS: Record<string, BotMentioned> = {
  [VIEWER]: { name: "Olive", self: true },
  [ANN]: { name: "Ann", self: false },
};

afterEach(cleanup);

function body(markdown: string) {
  return (
    <AgentReferenceMarkdown
      isStreaming={false}
      markdown={markdown}
      proseSize="compact"
      quotable={false}
      components={null}
    />
  );
}

function renderIn(markdown: string): HTMLElement {
  const { container } = render(
    <BotMentionsContext
      value={(userId) =>
        Object.hasOwn(MEMBERS, userId) ? MEMBERS[userId] : null
      }
    >
      {body(markdown)}
    </BotMentionsContext>,
  );
  return container;
}

describe("a bot message's mentions", () => {
  it("draws a member's token as their chip, marked for the viewer", () => {
    renderIn(`<@${ANN}> and <@${VIEWER}> please look`);

    const chips = screen.getAllByTestId("bot-mention");
    expect(chips.map((chip) => chip.textContent)).toEqual(["@Ann", "@Olive"]);
    expect(chips.map((chip) => chip.getAttribute("data-self"))).toEqual([
      "false",
      "true",
    ]);
  });

  it("leaves the token as written for someone who is not a member", () => {
    const container = renderIn(`hello <@${STRANGER}>`);

    expect(screen.queryByTestId("bot-mention")).toBeNull();
    expect(container.textContent).toContain(`<@${STRANGER}>`);
  });

  it("leaves the token as written outside any provider", () => {
    const { container } = render(body(`hello <@${ANN}>`));

    expect(screen.queryByTestId("bot-mention")).toBeNull();
    expect(container.textContent).toContain(`<@${ANN}>`);
  });
});
