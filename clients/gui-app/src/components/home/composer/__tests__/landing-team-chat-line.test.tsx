import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LandingTeamChatLine } from "@/components/home/composer/landing-team-chat-line";

/**
 * The first-chat line under a team sandbox says who will read the first chat;
 * under the person's own machine nothing is shown.
 */

afterEach(cleanup);

describe("<LandingTeamChatLine />", () => {
  it("says who will read the first chat when the owner is a team", () => {
    render(<LandingTeamChatLine owner={{ teamId: "t1", slug: "acme" }} />);

    expect(screen.getByTestId("landing-team-first-chat-line").textContent).toBe(
      "Chats here are visible to everyone in acme",
    );
  });

  it("is absent when the owner is Personal", () => {
    render(<LandingTeamChatLine owner={null} />);

    expect(screen.queryByTestId("landing-team-first-chat-line")).toBeNull();
  });
});
