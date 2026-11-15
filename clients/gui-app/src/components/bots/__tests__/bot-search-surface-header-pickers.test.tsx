/**
 * The header's bot pickers, through the REAL phone header, the REAL
 * `BotTabSurface`, the REAL `BotThreadsView`, the REAL `BotChannelSidebar` and
 * the REAL place and surface stores. The channel's composer and the settings
 * panel stay stand-ins; the fake hosts are those of
 * `bot-search-surface-support.tsx`.
 */
import "./bot-search-surface-stub-composer";
import "./bot-search-surface-stub-settings";
import { UnderHeader } from "./bot-search-surface-under-header";
import {
  conversationOf,
  installSearchSurfaceLifecycle,
  mocks,
  transcriptOf,
} from "./bot-search-surface-support";
import {
  chooseFromPicker,
  FORMS,
  headerButton,
  installCompactHeaderLifecycle,
  required,
  showThreadsFromHeader,
  userEvents,
} from "./bot-search-surface-compact-support";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  SEARCH_BOT_A,
  SEARCH_BOT_B,
} from "@/lib/bots/__tests__/bot-search-test-support";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

installSearchSurfaceLifecycle();

function headerPickerText(): string {
  return within(screen.getByTestId("app-header")).getByTestId(
    "bot-channel-picker-trigger",
  ).textContent;
}

describe("the Threads picker in the compact header", () => {
  const form = installCompactHeaderLifecycle();

  it.each(FORMS)(
    "returns to the channel when the current bot is chosen from the Threads picker at the %s form",
    async (_form, shape) => {
      const user = userEvents();
      form.shell().set(shape);
      render(<UnderHeader />);
      await showThreadsFromHeader(user);

      await chooseFromPicker(
        user,
        () => headerButton(/^Threads$/),
        "Release Bot",
      );

      expect(useTracyPlaceStore.getState().threadsShown).toBe(false);
      expect(screen.queryByTestId("bot-threads-view")).toBeNull();
      expect(screen.getByTestId("bot-tab-view-messages")).toBeTruthy();
      expect(headerPickerText()).toContain("Release Bot");
    },
  );

  it.each(FORMS)(
    "opens another bot's channel when it is chosen from the Threads picker at the %s form",
    async (_form, shape) => {
      const user = userEvents();
      form.shell().set(shape);
      render(<UnderHeader />);
      await showThreadsFromHeader(user);

      await chooseFromPicker(
        user,
        () => headerButton(/^Threads$/),
        "Notes Bot",
      );

      expect(mocks.activateTabIntent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tracy", botId: SEARCH_BOT_B }),
      );
      expect(useTracyPlaceStore.getState().threadsShown).toBe(false);
      expect(screen.queryByTestId("bot-threads-view")).toBeNull();
      expect(headerPickerText()).toContain("Notes Bot");
    },
  );
});

describe("the channel's bot picker in the compact header", () => {
  const form = installCompactHeaderLifecycle();

  it.each(FORMS)(
    "keeps the channel and its conversation when the current bot is chosen at the %s form",
    async (_form, shape) => {
      const user = userEvents();
      form.shell().set(shape);
      render(<UnderHeader />);
      const channel = required("bot-channel");
      const transcript = transcriptOf(conversationOf(SEARCH_BOT_A));

      await chooseFromPicker(
        user,
        () => screen.getByTestId("bot-channel-picker-trigger"),
        "Release Bot",
      );

      expect(required("bot-channel")).toBe(channel);
      expect(transcriptOf(conversationOf(SEARCH_BOT_A))).toBe(transcript);
      expect(useTracySurfaceStore.getState().botId).toBe(SEARCH_BOT_A);
    },
  );

  it.each(FORMS)(
    "selects another bot's channel and its conversation when it is chosen at the %s form",
    async (_form, shape) => {
      const user = userEvents();
      form.shell().set(shape);
      render(<UnderHeader />);

      await chooseFromPicker(
        user,
        () => screen.getByTestId("bot-channel-picker-trigger"),
        "Notes Bot",
      );

      expect(mocks.activateTabIntent).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "tracy", botId: SEARCH_BOT_B }),
      );
      expect(useTracySurfaceStore.getState().botId).toBe(SEARCH_BOT_B);
      expect(required("bot-channel").getAttribute("aria-label")).toBe(
        "Notes Bot",
      );
      expect(transcriptOf(conversationOf(SEARCH_BOT_B))).toBeTruthy();
      expect(headerPickerText()).toContain("Notes Bot");
    },
  );
});

/** A person with two main bots: the team's is the channel the surface shows. */
const TEAM_AND_PERSONAL_MAIN_BOTS: StandaloneBotsDirectory = {
  model: {
    groups: [
      {
        environmentId: "env-team",
        label: "traycerai",
        ownerKind: "organization",
        canCreate: true,
        bots: [tracyRecord(SEARCH_BOT_A, "env-team")],
        mainBotId: SEARCH_BOT_A,
      },
      {
        environmentId: "env-me",
        label: "Personal",
        ownerKind: "user",
        canCreate: true,
        bots: [tracyRecord(SEARCH_BOT_B, "env-me")],
        mainBotId: SEARCH_BOT_B,
      },
    ],
    botCount: 2,
  },
  setups: [],
};

describe("the Threads picker in the compact header with two main bots", () => {
  const form = installCompactHeaderLifecycle();

  afterEach(() => {
    useStandaloneBotsStore.setState({
      directory: { model: { groups: [], botCount: 0 }, setups: [] },
      settled: false,
      botsListed: false,
    });
  });

  it.each(FORMS)(
    "names Threads without the channel's team, and still returns to the channel when the current bot is chosen, at the %s form",
    async (_form, shape) => {
      const user = userEvents();
      useStandaloneBotsStore.setState({
        directory: TEAM_AND_PERSONAL_MAIN_BOTS,
        settled: true,
        botsListed: true,
      });
      form.shell().set(shape);
      render(<UnderHeader />);
      expect(headerPickerText()).toContain("Release Bot · traycerai");

      await showThreadsFromHeader(user);

      expect(headerPickerText()).toBe("Threads");

      await chooseFromPicker(
        user,
        () => headerButton(/^Threads$/),
        "Release Bot",
      );

      expect(useTracyPlaceStore.getState().threadsShown).toBe(false);
      expect(screen.getByTestId("bot-tab-view-messages")).toBeTruthy();
      expect(headerPickerText()).toContain("Release Bot");
    },
  );
});
