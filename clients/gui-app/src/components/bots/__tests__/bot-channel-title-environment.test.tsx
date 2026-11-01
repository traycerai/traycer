/**
 * The channel's title says the environment only where it is the picker, whose
 * list is closed while the title is read; beside a column it stays the name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import {
  EMPTY_DIRECTORY_STATE,
  ONE_PERSONAL_MAIN_BOT_DIRECTORY,
  ONE_TEAM_MAIN_BOT_DIRECTORY,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import type { MobileLevel2Form } from "@/lib/layout/mobile-layout-form";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

vi.mock("@/components/bots/bot-channel-sidebar", () => ({
  BotChannelSidebar: () => null,
}));

function titleText(botId: string, level2: MobileLevel2Form | null): string {
  render(
    <BotChannelTitle
      level2={level2}
      title="Tracy"
      activeBotId={botId}
      hostId="host-1"
      threadsView={null}
    />,
  );
  return screen.getByTestId("bot-tab-title").textContent;
}

afterEach(() => {
  cleanup();
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
});

describe("<BotChannelTitle /> and the environment", () => {
  it("places a team's bot in the picker when two main bots are visible", () => {
    useStandaloneBotsStore.setState({
      directory: TWO_MAIN_BOTS_DIRECTORY,
      settled: true,
    });

    expect(titleText(TEAM_MAIN_BOT_ID, "menu")).toBe("Tracy · traycerai");
  });

  it("never suffixes the personal bot", () => {
    useStandaloneBotsStore.setState({
      directory: TWO_MAIN_BOTS_DIRECTORY,
      settled: true,
    });

    expect(titleText(PERSONAL_MAIN_BOT_ID, "bar")).toBe("Tracy");
  });

  it("keeps a team's bot to its name when it is the only main bot", () => {
    useStandaloneBotsStore.setState({
      directory: ONE_TEAM_MAIN_BOT_DIRECTORY,
      settled: true,
    });

    expect(titleText(TEAM_MAIN_BOT_ID, "menu")).toBe("Tracy");
  });

  it("keeps the personal bot to its name when it is the only main bot", () => {
    useStandaloneBotsStore.setState({
      directory: ONE_PERSONAL_MAIN_BOT_DIRECTORY,
      settled: true,
    });

    expect(titleText(PERSONAL_MAIN_BOT_ID, "menu")).toBe("Tracy");
  });

  it("shows only the name in the pane header beside a column", () => {
    useStandaloneBotsStore.setState({
      directory: TWO_MAIN_BOTS_DIRECTORY,
      settled: true,
    });

    expect(titleText(TEAM_MAIN_BOT_ID, null)).toBe("Tracy");
  });
});
