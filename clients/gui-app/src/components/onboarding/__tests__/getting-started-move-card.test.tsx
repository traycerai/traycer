import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThisComputer } from "@/components/settings/move/this-computer";
import { GettingStartedCards } from "@/components/onboarding/getting-started-cards";
import {
  gettingStartedEntries,
  type GettingStartedFacts,
} from "@/components/onboarding/getting-started-checklist";
import { useMoveSheetStore } from "@/stores/settings/move-sheet-store";

/*
 * The move's invitation on the onboarding surfaces: Settings ▸ Getting
 * started and Home draw the same card, and its verb opens the move sheet -
 * the sheet is mounted app-wide, so the card works from either.
 */

const thisComputer = vi.hoisted((): { current: ThisComputer } => ({
  current: { hostId: "old", hostName: "Old laptop", client: null },
}));
vi.mock("@/components/settings/move/this-computer", () => ({
  useThisComputer: (): ThisComputer => thisComputer.current,
}));

vi.mock("@/lib/links/open-link", () => ({
  useOpenLink: () => vi.fn(() => Promise.resolve()),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHostOrNull: () => null,
}));

const NOT_MOVED: GettingStartedFacts = {
  providerSetUp: true,
  hasTask: true,
  hasSecret: true,
  hasSecondPersonalComputer: true,
  sandboxStaged: false,
  creditsAboveZero: false,
  thisComputersMove: "not_moved",
};

afterEach(() => {
  cleanup();
  useMoveSheetStore.setState({ target: null });
  thisComputer.current = {
    hostId: "old",
    hostName: "Old laptop",
    client: null,
  };
});

describe("the Getting started move card", () => {
  it("says what the move does and opens the sheet that shows what moves", () => {
    render(
      <GettingStartedCards
        entries={gettingStartedEntries(NOT_MOVED)}
        surface="settings"
      />,
    );

    const card = screen.getByTestId("getting-started-card-move");
    expect(card.textContent).toContain(
      "Move this computer's settings to Personal",
    );
    expect(card.textContent).toContain(
      "So they work on every computer and sandbox you use.",
    );
    expect(card.textContent).toContain("Show me what moves");

    fireEvent.click(card);

    expect(useMoveSheetStore.getState().target).toEqual({
      hostId: "old",
      hostName: "Old laptop",
    });
  });

  it("offers nothing to press with no computer of its own to move", () => {
    thisComputer.current = {
      hostId: null,
      hostName: "this computer",
      client: null,
    };
    render(
      <GettingStartedCards
        entries={gettingStartedEntries(NOT_MOVED)}
        surface="home"
      />,
    );

    fireEvent.click(screen.getByTestId("getting-started-card-move"));

    expect(useMoveSheetStore.getState().target).toBeNull();
  });
});
