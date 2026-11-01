/**
 * The channel's title says the environment only where it is the picker, whose
 * list is closed while the title is read; beside a column it stays the name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BotChannelTitle } from "@/components/bots/bot-channel-level2";
import {
  ONE_MAIN_BOT_MODEL,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_MODEL,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { EMPTY_HOME_BOTS_MODEL } from "@/lib/home-bots/bots-model";
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
  useStandaloneBotsStore.setState({ model: EMPTY_HOME_BOTS_MODEL });
});

describe("<BotChannelTitle /> and the environment", () => {
  it("places a team's bot in the picker when two main bots are visible", () => {
    useStandaloneBotsStore.setState({ model: TWO_MAIN_BOTS_MODEL });

    expect(titleText(TEAM_MAIN_BOT_ID, "menu")).toBe("Tracy · traycerai");
  });

  it("never suffixes the personal bot", () => {
    useStandaloneBotsStore.setState({ model: TWO_MAIN_BOTS_MODEL });

    expect(titleText(PERSONAL_MAIN_BOT_ID, "bar")).toBe("Tracy");
  });

  it("shows only the name in the picker when one main bot is visible", () => {
    useStandaloneBotsStore.setState({ model: ONE_MAIN_BOT_MODEL });

    expect(titleText(PERSONAL_MAIN_BOT_ID, "menu")).toBe("Tracy");
  });

  it("shows only the name in the pane header beside a column", () => {
    useStandaloneBotsStore.setState({ model: TWO_MAIN_BOTS_MODEL });

    expect(titleText(TEAM_MAIN_BOT_ID, null)).toBe("Tracy");
  });
});
