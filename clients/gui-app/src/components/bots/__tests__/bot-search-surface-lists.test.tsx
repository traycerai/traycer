/**
 * Search in Tracy (decision 186): where a search is first asked, when the
 * lists that say which host holds each bot are not in yet, and when what the
 * client reaches changes. The search panel is the real one over the real
 * search hook; the fake hosts and the module mocks are in
 * `bot-search-surface-support.tsx`. The bot list loading is read by the whole
 * channel surface, which draws no panel while it is out, so the panel is
 * drawn alone for the cases that hold it out.
 * The clock is a fake one, so the debounce is crossed by advancing it.
 */
import {
  mocks,
  HOST_A,
  TAB_HOST,
  changeLists,
  hitRows,
  searchQueryClient,
  settle,
  typeIntoPanel,
  installSearchSurfaceLifecycle,
} from "./bot-search-surface-support";
import { Surface } from "./bot-search-surface-view";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BotSearchPanel } from "@/components/bots/bot-search-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SEARCH_BOT_A } from "@/lib/bots/__tests__/bot-search-test-support";
import { openBotSearch } from "@/stores/bots/bot-search-store";

installSearchSurfaceLifecycle();

/** Only the search panel, beside Release Bot's channel. */
function PanelOnly(): ReactNode {
  return (
    <QueryClientProvider client={searchQueryClient()}>
      <TooltipProvider>
        <BotSearchPanel
          botId={SEARCH_BOT_A}
          botTitle="Release Bot"
          hostId={TAB_HOST}
          environmentId="env-team"
          onClose={() => undefined}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function hostsAsked(): string[] {
  return mocks.asked.map((entry) => entry.hostId);
}

describe("a search of one bot opened before the lists that place it have loaded", () => {
  it.each([
    [
      "the bot list is still loading",
      (): void => {
        mocks.state.botListState = "pending";
      },
      (): void => {
        mocks.state.botListState = "ready";
      },
    ],
    [
      "the connectable hosts are not resolved",
      (): void => {
        mocks.state.connectableResolved = false;
      },
      (): void => {
        mocks.state.connectableResolved = true;
      },
    ],
  ] as const)(
    "asks nothing while %s, and then asks the bot's own host first, not the tab's",
    async (_unloaded, hold, release) => {
      hold();
      openBotSearch(
        SEARCH_BOT_A,
        { kind: "bot", botId: SEARCH_BOT_A },
        "release",
      );
      render(<PanelOnly />);
      await settle();
      await settle();

      expect(mocks.asked).toEqual([]);
      expect(screen.getByTestId("bot-search-loading")).toBeTruthy();

      changeLists(release);
      await settle();

      expect(hostsAsked()).toEqual([HOST_A]);
      expect(hitRows()).toHaveLength(1);
    },
  );

  it("searches on the tab's host when the bot list fails to load, rather than waiting on it", async () => {
    mocks.state.botListState = "error";
    openBotSearch(
      SEARCH_BOT_A,
      { kind: "bot", botId: SEARCH_BOT_A },
      "release",
    );
    render(<PanelOnly />);
    await settle();

    expect(hostsAsked()).toEqual([TAB_HOST]);
    expect(hitRows()).toHaveLength(1);
    expect(screen.queryByTestId("bot-search-loading")).toBeNull();
  });
});

describe("a change in the hosts this client reaches", () => {
  it("is a new search: a bot's host that becomes connectable is asked next, where the tab's host answered before", async () => {
    mocks.state.connectable = [TAB_HOST];
    render(<Surface />);
    fireEvent.click(
      screen.getByRole("button", { name: "Search in Release Bot" }),
    );
    await typeIntoPanel("release");
    expect(hostsAsked()).toEqual([TAB_HOST]);

    changeLists(() => {
      mocks.state.connectable = [TAB_HOST, HOST_A];
    });
    await settle();

    expect(hostsAsked()).toEqual([TAB_HOST, HOST_A]);
    expect(mocks.asked[1].request.scope).toEqual({
      kind: "bot",
      botId: SEARCH_BOT_A,
    });
    expect(hitRows()).toHaveLength(1);
  });
});
