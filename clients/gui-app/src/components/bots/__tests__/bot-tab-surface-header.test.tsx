/**
 * The Tracy surface (Tracy Bots) under the phone app header and beside the
 * bots column: where the bot's name and the channel's controls are drawn
 * there, which pane owns the shared header, the header giving way to a field
 * the keyboard focus serves, and the one music group the tab draws in every
 * state. Its setup is shared with `bot-tab-surface.test.tsx` through
 * `bot-tab-surface-view-stubs.tsx` and `bot-tab-surface-render.tsx`.
 */
import {
  botListChangedMock,
  botListQueryMock,
  botMemoryMock,
  botMutationsMock,
  botSubscriptionMock,
  botThreadListQueryMock,
  connectableHostIdsMock,
  environmentListMock,
  environmentMembersMock,
  hostDirectoryListMock,
  hostEnvironmentBindingsMock,
  cloudEpicTasksMock,
  epicTaskContextsMock,
  hostClientForHostIdMock,
  hostQueriesMock,
  hostSupportsMethodMock,
  mocks,
  notificationHostMock,
  tabHostClientMock,
  tabHostProviderMock,
  tabNavigationMock,
} from "./bot-tab-surface-mocks";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { KEYBOARD_FOCUS_OWNER_PROPS } from "@/hooks/ui/use-keyboard-focus-layout";
import { setPhoneLayoutOnly } from "@/lib/mobile-app";
import {
  holdScreenLandscape,
  IPHONE_17,
  lowerNativeKeyboard,
  raiseNativeKeyboard,
  restoreKeyboardEnvironment,
} from "../../../../__tests__/short-keyboard-viewport-harness";

import {
  installShellForm,
  SHELL_WIDTH_COLUMN_256,
  SHELL_WIDTH_MENU,
  type ShellFormHarness,
} from "../../../../__tests__/mobile-level2-form-harness";
import { StrictMode, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOT,
  answer,
  BOT_ID,
  NEEDS_HOST_SETUP,
  OTHER_BOT_ID,
  setUpNewTeam,
  SETUP_BOT_ID,
  snapshot,
  TAB_HOST,
} from "./bot-tab-surface-harness";

vi.mock("@/lib/soundtrack/manifest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/soundtrack/manifest")>()),
  soundtrackOffered: () => true,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/providers/use-resolved-theme", () => ({
  useResolvedTheme: () => ({ resolvedTheme: "dark", themePreset: "neutral" }),
}));
vi.mock("@/components/layout/header/rate-limit-icon", () => ({
  RateLimitIconButton: () => null,
}));
vi.mock("@/components/resources/resource-monitor-popover", () => ({
  ResourceMonitorPopover: () => null,
}));
vi.mock("@/components/notifications/mobile-notifications-button", () => ({
  MobileNotificationsButton: () => null,
}));
vi.mock("@/lib/tab-navigation", async (importOriginal) =>
  tabNavigationMock(
    await importOriginal<typeof import("@/lib/tab-navigation")>(),
  ),
);
// The tasks a bot's channel can name come from two host reads, scripted here:
// the titles of the stream's tasks, and Home's task list.
vi.mock(
  "@/hooks/epic/use-epic-get-task-contexts-query",
  () => epicTaskContextsMock,
);
vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", async (importOriginal) =>
  cloudEpicTasksMock(
    await importOriginal<
      typeof import("@/hooks/epics/use-cloud-epic-tasks-query")
    >(),
  ),
);
vi.mock("@/hooks/host/use-host-supports-method", () => hostSupportsMethodMock);
// The Activity count reads the notification indicators through the notification
// host; the query transport below answers them.
vi.mock(
  "@/hooks/notifications/use-notification-host",
  () => notificationHostMock,
);
vi.mock(
  "@/hooks/host/use-host-client-for-host-id",
  () => hostClientForHostIdMock,
);
vi.mock("@/hooks/host/use-host-queries", () => hostQueriesMock);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () => mocks.binding,
  useHostClient: () => null,
}));
vi.mock("@/hooks/sandboxes/use-sandbox-defaults", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/sandboxes/use-sandbox-defaults")
  >()),
  useSandboxDefaults: (environmentIds: readonly string[]) =>
    new Map(environmentIds.map((id) => [id, mocks.sandboxDefaults])),
}));
vi.mock(
  "@/hooks/bots/use-host-environment-bindings-query",
  () => hostEnvironmentBindingsMock,
);
vi.mock(
  "@/hooks/bots/use-environment-members-query",
  () => environmentMembersMock,
);

vi.mock(
  "@/components/epic-canvas/tab-host-provider",
  () => tabHostProviderMock,
);
vi.mock("@/hooks/host/use-tab-host-client", () => tabHostClientMock);
vi.mock(
  "@/components/epic-tabs/pane-visibility-context",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/components/epic-tabs/pane-visibility-context")
    >()),
    usePaneVisible: () => mocks.state.paneVisible,
  }),
);
// The card's memory row is driven in `bot-memory-pane.test.tsx`.
vi.mock("@/hooks/bots/use-bot-memory", () => botMemoryMock);
vi.mock("@/hooks/bots/use-bot-subscription", () => botSubscriptionMock);
vi.mock("@/hooks/host/use-connectable-host-ids", () => connectableHostIdsMock);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  () => hostDirectoryListMock,
);
vi.mock("@/hooks/bots/use-bot-list-query", () => botListQueryMock);
vi.mock(
  "@/hooks/bots/use-bot-list-changed-subscription",
  () => botListChangedMock,
);
vi.mock("@/hooks/bots/use-environment-list-query", () => environmentListMock);
vi.mock("@/hooks/bots/use-bot-mutations", () => botMutationsMock);
vi.mock(
  "@/components/bots/bot-channel-sidebar",
  () => import("./bot-tab-surface-view-stubs"),
);
vi.mock(
  "@/components/bots/bot-channel-view",
  () => import("./bot-tab-surface-view-stubs"),
);
vi.mock(
  "@/components/bots/bot-session-view",
  () => import("./bot-tab-surface-view-stubs"),
);
vi.mock(
  "@/components/bots/bot-activity-page",
  () => import("./bot-tab-surface-view-stubs"),
);
vi.mock(
  "@/components/bots/bot-threads-view",
  () => import("./bot-tab-surface-view-stubs"),
);
vi.mock("@/hooks/bots/use-bot-thread-list-query", () => botThreadListQueryMock);
vi.mock(
  "@/components/bots/bot-settings-panel",
  () => import("./bot-tab-surface-view-stubs"),
);

import { BotTabSurface } from "@/components/bots/bot-tab-surface";
import { useTracyPlaceStore } from "@/stores/bots/tracy-place-store";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { MobileAppHeader } from "@/components/layout/header/mobile-app-header";
import { MobileBotHeaderSlotProvider } from "@/components/layout/header/mobile-bot-header-slot";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { useTracySurfaceStore } from "@/stores/bots/tracy-surface-store";

import { useBotDraftsStore } from "@/stores/bots/bot-drafts-store";
import {
  installBotTabSurfaceCaseLifecycle,
  queryClient,
  surface,
  surfaceFor,
} from "./bot-tab-surface-render";

installBotTabSurfaceCaseLifecycle();

const TRACY_REF = { kind: "tracy", id: "tracy" } as const;
const SETTINGS_REF = { kind: "settings", id: "settings" } as const;

/** Focus the Tracy tab, or another, through the layout the header resolves from. */
function focusTab(ref: typeof TRACY_REF | typeof SETTINGS_REF): void {
  const id = tabItemId(ref);
  useTabsStore.setState({
    items: [
      { kind: "tab", id: tabItemId(TRACY_REF), ref: TRACY_REF },
      { kind: "tab", id: tabItemId(SETTINGS_REF), ref: SETTINGS_REF },
    ],
    activeItemId: id,
    stripOrder: [TRACY_REF, SETTINGS_REF],
  });
}

/** The surface under the real phone header, as the shell stacks them. */
function surfaceUnderHeader(botId: string | null): ReactNode {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MobileBotHeaderSlotProvider>
          <MobileAppHeader />
          <BotTabSurface botId={botId} hostId={TAB_HOST} />
        </MobileBotHeaderSlotProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

function headerPicker(): HTMLElement | null {
  return within(screen.getByTestId("app-header")).queryByTestId(
    "bot-channel-picker-trigger",
  );
}

function channelPicker(): HTMLElement | null {
  return within(screen.getByTestId("bot-channel-header")).queryByTestId(
    "bot-channel-picker-trigger",
  );
}

describe("<BotTabSurface /> under the compact app header", () => {
  let shell: ShellFormHarness;
  beforeEach(() => {
    shell = installShellForm(SHELL_WIDTH_MENU);
    focusTab(TRACY_REF);
  });
  afterEach(() => {
    shell.dispose();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("puts the bot's name in the app-header row beside the menu, and draws no second identity row in the channel", () => {
    render(surfaceUnderHeader(BOT_ID));

    const header = screen.getByTestId("app-header");
    expect(within(header).getByTestId("mobile-nav-trigger")).toBeTruthy();
    expect(headerPicker()?.textContent).toContain("Release Bot");
    expect(channelPicker()).toBeNull();
    expect(
      within(screen.getByTestId("bot-channel-header")).queryByTestId(
        "bot-tab-title",
      ),
    ).toBeNull();
    expect(screen.getByTestId("bot-tab-avatar")).toBeTruthy();
  });

  it("opens the bot picker from the header title, and a pick or Threads closes it with the header kept", async () => {
    const user = userEvent.setup();
    render(surfaceUnderHeader(BOT_ID));

    const trigger = headerPicker();
    if (trigger === null) throw new Error("no picker in the app header");
    await user.click(trigger);
    const picker = await screen.findByTestId("bot-channel-picker");
    await user.click(within(picker).getByTestId("stub-sidebar-pick"));
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
    });
    expect(headerPicker()).not.toBeNull();

    await user.click(trigger);
    await user.click(
      within(await screen.findByTestId("bot-channel-picker")).getByTestId(
        "stub-sidebar-threads",
      ),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
    });
    expect(screen.getByTestId("stub-threads")).toBeTruthy();
  });

  // `BotThreadsView` is a stub in this suite: only identity leakage is checked here.
  it("keeps the bot picker in the header while a session shows, and Back returns to the same channel", async () => {
    const user = userEvent.setup();
    render(surfaceUnderHeader(BOT_ID));

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(screen.getByTestId("stub-session")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    const trigger = headerPicker();
    if (trigger === null) throw new Error("no picker in the app header");
    expect(trigger.textContent).toContain("Release Bot");
    await user.click(trigger);
    expect(
      within(await screen.findByTestId("bot-channel-picker")).getByTestId(
        "stub-sidebar",
      ).dataset.activeBotId,
    ).toBe(BOT_ID);
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
    });

    await user.click(screen.getByTestId("stub-session-back"));

    expect(screen.queryByTestId("stub-session")).toBeNull();
    expect(screen.getByTestId("stub-channel").dataset.botTitle).toBe(
      "Release Bot",
    );
    expect(headerPicker()?.textContent).toContain("Release Bot");
    expect(
      screen.getByTestId("bot-tab-view-messages").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("does not leave the prior bot's name in the header once Threads replaces the channel", async () => {
    const user = userEvent.setup();
    render(surfaceUnderHeader(BOT_ID));
    const trigger = headerPicker();
    if (trigger === null) throw new Error("no picker in the app header");
    await user.click(trigger);
    await user.click(
      within(await screen.findByTestId("bot-channel-picker")).getByTestId(
        "stub-sidebar-threads",
      ),
    );
    await screen.findByTestId("stub-threads");

    expect(
      within(screen.getByTestId("app-header")).queryByText("Release Bot"),
    ).toBeNull();
  });

  it("hides the tab list and moves Messages, Activity and Channel settings into the Channel actions menu, with the picture kept", async () => {
    const user = userEvent.setup();
    render(surfaceUnderHeader(BOT_ID));

    // The list stays mounted for the panels' tab relationships, hidden.
    for (const id of ["bot-tab-view-messages", "bot-tab-view-activity"]) {
      expect(screen.getByTestId(id).closest("[hidden]")).not.toBeNull();
    }
    expect(screen.queryByRole("tab", { name: "Messages" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    expect(screen.getByTestId("bot-tab-avatar")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Channel actions/ }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Activity/ }),
    );
    expect(screen.getByTestId("stub-activity")).toBeTruthy();
    expect(screen.queryByTestId("stub-channel")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^Channel actions/ }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Messages/ }),
    );
    expect(screen.getByTestId("stub-channel")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Channel actions/ }));
    await user.click(
      within(await screen.findByRole("menu")).getByText(/settings/i),
    );
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
  });

  it("is absent on another focused tab while the surface stays mounted, and returns with the draft intact", async () => {
    const user = userEvent.setup();
    render(surfaceUnderHeader(BOT_ID));
    await user.type(screen.getByLabelText("Channel box"), "unsent words");
    const channel = screen.getByTestId("stub-channel");

    act(() => focusTab(SETTINGS_REF));
    expect(headerPicker()).toBeNull();
    expect(
      within(screen.getByTestId("app-header")).queryByText("Release Bot"),
    ).toBeNull();

    act(() => focusTab(TRACY_REF));
    expect(headerPicker()?.textContent).toContain("Release Bot");
    expect(screen.getByTestId("stub-channel")).toBe(channel);
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Channel box").value,
    ).toBe("unsent words");
  });

  describe("two shells in one document", () => {
    const OTHER_SNAPSHOT = {
      ...snapshot(),
      bot: { ...BOT, botId: OTHER_BOT_ID, title: "Other Bot" },
    };

    beforeEach(() => {
      mocks.state.listedBotIds = [BOT_ID, OTHER_BOT_ID];
      vi.spyOn(
        botSubscriptionMock,
        "useBotSubscriptionForHost",
      ).mockImplementation((input) => {
        mocks.subscribed.push(input.botId);
        return {
          snapshot:
            input.botId === OTHER_BOT_ID
              ? OTHER_SNAPSHOT
              : mocks.state.snapshot,
          snapshotFresh: true,
          deleted: mocks.state.deleted,
          error: mocks.state.error,
          isPending: false,
          resubscribe: mocks.resubscribe,
        };
      });
    });
    afterEach(() => {
      vi.mocked(botSubscriptionMock.useBotSubscriptionForHost).mockRestore();
    });

    function shells(surfaceInA: boolean, surfaceInB: boolean): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          <div data-testid="shell-a">
            <MobileBotHeaderSlotProvider>
              <MobileAppHeader />
              {surfaceInA ? (
                <BotTabSurface botId={BOT_ID} hostId={TAB_HOST} />
              ) : null}
            </MobileBotHeaderSlotProvider>
          </div>
          <div data-testid="shell-b">
            <MobileBotHeaderSlotProvider>
              <MobileAppHeader />
              {surfaceInB ? (
                <BotTabSurface botId={OTHER_BOT_ID} hostId={TAB_HOST} />
              ) : null}
            </MobileBotHeaderSlotProvider>
          </div>
        </QueryClientProvider>
      );
    }

    function pickerIn(shell: string): HTMLElement | null {
      return within(
        within(screen.getByTestId(shell)).getByTestId("app-header"),
      ).queryByTestId("bot-channel-picker-trigger");
    }

    /** The bot a shell's picker lists as current, opened and closed again. */
    async function currentBotOf(
      user: UserEvent,
      shell: string,
    ): Promise<string | undefined> {
      const trigger = pickerIn(shell);
      if (trigger === null) throw new Error(`no picker in ${shell}'s header`);
      await user.click(trigger);
      const current = within(
        await screen.findByTestId("bot-channel-picker"),
      ).getByTestId("stub-sidebar").dataset.activeBotId;
      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
      });
      return current;
    }

    it("shows each shell its own bot, in the title and in the picker", async () => {
      const user = userEvent.setup();
      render(shells(true, true));

      expect(pickerIn("shell-a")?.textContent).toContain("Release Bot");
      expect(pickerIn("shell-a")?.textContent).not.toContain("Other Bot");
      expect(pickerIn("shell-b")?.textContent).toContain("Other Bot");
      expect(pickerIn("shell-b")?.textContent).not.toContain("Release Bot");
      expect(await currentBotOf(user, "shell-a")).toBe(BOT_ID);
      expect(await currentBotOf(user, "shell-b")).toBe(OTHER_BOT_ID);
    });

    it("takes only one shell's title away when that shell's surface unmounts", async () => {
      const user = userEvent.setup();
      const view = render(shells(true, true));

      view.rerender(shells(false, true));

      expect(pickerIn("shell-a")).toBeNull();
      expect(pickerIn("shell-b")?.textContent).toContain("Other Bot");
      expect(await currentBotOf(user, "shell-b")).toBe(OTHER_BOT_ID);
    });
  });

  describe("split panes under one shared header", () => {
    interface PaneState {
      readonly visible: boolean;
      readonly focused: boolean;
    }
    const FOCUSED: PaneState = { visible: true, focused: true };
    const KEPT_BEHIND: PaneState = { visible: true, focused: false };
    const HIDDEN: PaneState = { visible: false, focused: true };

    function pane(id: string, botId: string, state: PaneState): ReactNode {
      return (
        <div data-testid={id}>
          <PaneVisibilityContext.Provider value={state.visible}>
            <PaneSurfaceActivityContext.Provider value={state}>
              <BotTabSurface botId={botId} hostId={TAB_HOST} />
            </PaneSurfaceActivityContext.Provider>
          </PaneVisibilityContext.Provider>
        </div>
      );
    }

    function splitPanes(a: PaneState, b: PaneState): ReactNode {
      return (
        <QueryClientProvider client={queryClient}>
          <MobileBotHeaderSlotProvider>
            <MobileAppHeader />
            {pane("pane-a", BOT_ID, a)}
            {pane("pane-b", OTHER_BOT_ID, b)}
          </MobileBotHeaderSlotProvider>
        </QueryClientProvider>
      );
    }

    /** The bot the header's picker lists as current, which names the pane that owns the header. */
    async function headerOwner(user: UserEvent): Promise<string | undefined> {
      const trigger = headerPicker();
      if (trigger === null) throw new Error("no picker in the app header");
      await user.click(trigger);
      const owner = within(
        await screen.findByTestId("bot-channel-picker"),
      ).getByTestId("stub-sidebar").dataset.activeBotId;
      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByTestId("bot-channel-picker")).toBeNull();
      });
      return owner;
    }

    it("puts no title in the header from a pane kept behind or one that is not visible", () => {
      const view = render(splitPanes(KEPT_BEHIND, KEPT_BEHIND));
      expect(headerPicker()).toBeNull();

      view.rerender(splitPanes(HIDDEN, KEPT_BEHIND));
      expect(headerPicker()).toBeNull();
    });

    it("hands the header to the pane that takes the focus, and keeps both panes' content", async () => {
      const user = userEvent.setup();
      const view = render(splitPanes(FOCUSED, KEPT_BEHIND));
      const channelA = within(screen.getByTestId("pane-a")).getByTestId(
        "stub-channel",
      );
      const channelB = within(screen.getByTestId("pane-b")).getByTestId(
        "stub-channel",
      );
      await user.type(
        within(screen.getByTestId("pane-b")).getByLabelText("Channel box"),
        "partner draft",
      );
      expect(await headerOwner(user)).toBe(BOT_ID);

      view.rerender(splitPanes(KEPT_BEHIND, FOCUSED));

      expect(await headerOwner(user)).toBe(OTHER_BOT_ID);
      expect(
        within(screen.getByTestId("pane-a")).getByTestId("stub-channel"),
      ).toBe(channelA);
      expect(
        within(screen.getByTestId("pane-b")).getByTestId("stub-channel"),
      ).toBe(channelB);
      expect(
        within(
          screen.getByTestId("pane-b"),
        ).getByLabelText<HTMLTextAreaElement>("Channel box").value,
      ).toBe("partner draft");
    });
  });

  it("draws no title in the header outside the installed app, where the channel keeps its own", () => {
    setPhoneLayoutOnly(false);
    render(surfaceUnderHeader(BOT_ID));

    expect(headerPicker()).toBeNull();
    expect(
      within(screen.getByTestId("app-header")).queryByText("Release Bot"),
    ).toBeNull();
    expect(
      within(screen.getByTestId("bot-channel-header")).getByTestId(
        "bot-tab-title",
      ).textContent,
    ).toContain("Release Bot");
  });
});

describe("<BotTabSurface /> beside the bots column under the app header", () => {
  let shell: ShellFormHarness;
  beforeEach(() => {
    shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    focusTab(TRACY_REF);
  });
  afterEach(() => {
    shell.dispose();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  });

  it("keeps the channel's own tabs, Search and settings buttons, and gives the app header no bot name and no Channel actions menu", () => {
    render(surfaceUnderHeader(BOT_ID));

    expect(screen.getByTestId("bot-channel-sidebar-pane").style.width).toBe(
      "256px",
    );
    for (const name of ["Messages", "Activity"]) {
      const tab = screen.getByRole("tab", { name });
      expect(tab.closest("[hidden]")).toBeNull();
    }
    expect(screen.getByTestId("bot-channel-search-open")).toBeTruthy();
    expect(screen.getByTestId("bot-channel-settings-open")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Channel actions/ }),
    ).toBeNull();
    expect(headerPicker()).toBeNull();
    expect(
      within(screen.getByTestId("app-header")).queryByText("Release Bot"),
    ).toBeNull();
    expect(screen.getByTestId("bot-tab-title").textContent).toContain(
      "Release Bot",
    );
  });

  it("draws the music controls in the channel header's title row, left of Search, and no row of their own", () => {
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
    render(surfaceUnderHeader(BOT_ID));

    const group = screen.getByRole("group", { name: "Music playback" });
    expect(
      screen.getAllByRole("group", { name: "Music playback" }),
    ).toHaveLength(1);
    const search = screen.getByTestId("bot-channel-search-open");
    const row = group.closest(".\\@container\\/title-strip");
    expect(row).not.toBeNull();
    expect(row?.contains(search)).toBe(true);
    expect(
      group.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps one row for the music controls over the empty state when there are no bots, outside any channel header", () => {
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
    mocks.state.listedBotIds = [];
    render(surfaceUnderHeader(null));

    const groups = screen.getAllByRole("group", { name: "Music playback" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.closest('[data-testid="bot-channel-header"]')).toBeNull();
    expect(
      groups[0]?.compareDocumentPosition(
        screen.getByTestId("bot-tab-no-channel"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps one row for the music controls over the failure notice when the lists could not be read, outside any channel header", () => {
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
    mocks.state.listedBotIds = undefined;
    mocks.state.listFailed = true;
    render(surfaceUnderHeader(null));

    const groups = screen.getAllByRole("group", { name: "Music playback" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.closest('[data-testid="bot-channel-header"]')).toBeNull();
    expect(
      groups[0]?.compareDocumentPosition(screen.getByTestId("bot-tab-error")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("<BotTabSurface /> under the app header on a short viewport with the keyboard up", () => {
  beforeEach(() => {
    setPhoneLayoutOnly(true);
    holdScreenLandscape();
    raiseNativeKeyboard(IPHONE_17);
    focusTab(TRACY_REF);
  });
  afterEach(() => {
    setPhoneLayoutOnly(false);
    restoreKeyboardEnvironment();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
  });

  it("gives the whole app header up while a field the focus layout serves has the focus, and restores it with the keyboard down", () => {
    render(
      <>
        {surfaceUnderHeader(BOT_ID)}
        <div {...KEYBOARD_FOCUS_OWNER_PROPS}>
          <textarea aria-label="Owner box" />
        </div>
      </>,
    );
    expect(screen.getByTestId("app-header").hidden).toBe(false);

    act(() => screen.getByLabelText("Owner box").focus());
    expect(screen.getByTestId("app-header").hidden).toBe(true);

    lowerNativeKeyboard();
    expect(screen.getByTestId("app-header").hidden).toBe(false);
  });
});

describe("<BotTabSurface /> beside the bots column with the keyboard up", () => {
  let shell: ShellFormHarness;
  beforeEach(() => {
    shell = installShellForm(SHELL_WIDTH_COLUMN_256);
    raiseNativeKeyboard(IPHONE_17);
    focusTab(TRACY_REF);
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
  });
  afterEach(() => {
    shell.dispose();
    restoreKeyboardEnvironment();
    useTabsStore.setState(useTabsStore.getInitialState(), true);
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  });

  it("keeps the music group out of the channel header's hidden title row while a thread's box has the focus, and returns it to the row when the focus leaves", () => {
    render(surfaceUnderHeader(BOT_ID));
    const header = screen.getByTestId("bot-channel-header");
    expect(
      within(header).getByRole("group", { name: "Music playback" }),
    ).toBeTruthy();

    act(() => screen.getByLabelText("Thread box").focus());
    expect(header.hidden).toBe(true);
    // `hidden` also counts a group the hidden row still holds.
    const groups = screen.getAllByRole("group", {
      name: "Music playback",
      hidden: true,
    });
    expect(groups).toHaveLength(1);
    expect(header.contains(groups[0] ?? null)).toBe(false);
    expect(groups[0]?.closest("[hidden]")).toBeNull();

    act(() => screen.getByLabelText("Channel box").focus());
    expect(header.hidden).toBe(false);
    expect(
      within(header).getByRole("group", { name: "Music playback" }),
    ).toBeTruthy();
  });
});

describe("<BotTabSurface /> the one music group", () => {
  const GROUP = { name: "Music playback" } as const;

  /**
   * Where the group is drawn. The channel's own header holds it, or a setup
   * channel's, or the reserved title row a channel draws before its header
   * exists, or the Threads view's, or a row of its own over the tab outside
   * any `<header>`.
   */
  type Placement =
    | "title row"
    | "setup title row"
    | "reserved title row"
    | "threads title row"
    | "row";
  const HEADER_OF: Readonly<Record<Placement, string | null>> = {
    "title row": "bot-channel-header",
    "setup title row": "team-setup-header",
    "reserved title row": "bot-channel-opening-header",
    "threads title row": "stub-threads-header",
    row: null,
  };

  beforeEach(() => {
    useSettingsStore.setState({
      soundtrackEnabled: true,
      soundtrackPlaybackControls: true,
    });
  });
  afterEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  });

  /** The tab's only group, and the `<header>` it sits in, or `null` in a row of its own. */
  function onlyGroup(): { group: HTMLElement; header: Element | null } {
    // `getByRole` throws on a second group, as it does on none.
    const group = screen.getByRole("group", GROUP);
    return { group, header: group.closest("header") };
  }

  function placementOf(): Placement {
    const testId = onlyGroup().header?.getAttribute("data-testid") ?? null;
    const placement = (Object.keys(HEADER_OF) as Placement[]).find(
      (key) => HEADER_OF[key] === testId,
    );
    if (placement === undefined) throw new Error(`group in ${testId}`);
    return placement;
  }

  function expectPlacement(placement: Placement): void {
    expect(placementOf()).toBe(placement);
  }

  interface PlacedState {
    readonly state: string;
    readonly script: () => void;
    /** The channel the surface is asked for: none, the listed bot, or the team's unlisted main bot. */
    readonly channel: string | null;
    /** A test id that shows what the surface draws meanwhile. */
    readonly shown: string;
    readonly placement: Placement;
  }

  it.each<PlacedState>([
    {
      state: "the host's support is unknown",
      script: () => {
        mocks.state.support = null;
      },
      channel: BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "the host lacks bot.open",
      script: () => {
        mocks.state.support = false;
      },
      channel: BOT_ID,
      shown: "bot-tab-unavailable",
      placement: "row",
    },
    {
      state: "the account's drafts are not yet admitted",
      script: () => {
        useBotDraftsStore.setState({
          owner: { userId: "user-outgoing" },
          ownDraftsRead: false,
        });
      },
      channel: BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "Threads shows in place of the channel",
      script: () => {
        useTracyPlaceStore.getState().setThreadsShown(true);
      },
      channel: BOT_ID,
      shown: "stub-threads",
      placement: "threads title row",
    },
    {
      state: "Threads shows before the lists answer and no channel is selected",
      script: () => {
        useTracyPlaceStore.getState().setThreadsShown(true);
        mocks.state.listedBotIds = undefined;
        useTracySurfaceStore.setState({ botId: null });
      },
      channel: null,
      shown: "stub-threads",
      placement: "threads title row",
    },
    {
      state: "Threads shows and the lists answered with no bot to choose",
      script: () => {
        useTracyPlaceStore.getState().setThreadsShown(true);
        mocks.state.listedBotIds = [];
        useTracySurfaceStore.setState({ botId: null });
      },
      channel: null,
      shown: "stub-threads",
      placement: "threads title row",
    },
    {
      state: "a team's main bot is being set up",
      script: () => {
        setUpNewTeam();
        mocks.reads["env-new"] = { setup: NEEDS_HOST_SETUP };
      },
      channel: SETUP_BOT_ID,
      shown: "team-setup-channel",
      placement: "setup title row",
    },
    {
      state: "the lists have not answered and no channel is selected",
      script: () => {
        mocks.state.listedBotIds = undefined;
        useTracySurfaceStore.setState({ botId: null });
      },
      channel: null,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "the lists answered and the default channel is being chosen",
      script: () => {
        mocks.state.listedBotIds = [BOT_ID];
        useTracySurfaceStore.setState({ botId: null });
      },
      channel: null,
      shown: "bot-tab-content-pane",
      placement: "reserved title row",
    },
    {
      state: "the channel's lists have not answered",
      script: () => {
        mocks.state.listedBotIds = undefined;
      },
      channel: BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "the channel's bot.open has not answered",
      script: () => {
        mocks.state.openResult = null;
      },
      channel: BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "the channel's bot.open failed with no earlier answer",
      script: () => {
        mocks.state.openResult = { kind: "error", message: "the host is busy" };
      },
      channel: BOT_ID,
      shown: "bot-tab-error",
      placement: "reserved title row",
    },
    {
      state: "the channel's stream failed before a snapshot",
      script: () => {
        mocks.state.snapshot = null;
        mocks.state.error = "stream closed";
      },
      channel: BOT_ID,
      shown: "bot-tab-error",
      placement: "reserved title row",
    },
    {
      state: "the channel's stream has no snapshot yet",
      script: () => {
        mocks.state.snapshot = null;
      },
      channel: BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "a team's setup read is pending",
      script: setUpNewTeam,
      channel: SETUP_BOT_ID,
      shown: "bot-tab-connecting",
      placement: "reserved title row",
    },
    {
      state: "a team's setup read failed",
      script: () => {
        setUpNewTeam();
        mocks.reads["env-new"] = "fails";
      },
      channel: SETUP_BOT_ID,
      shown: "bot-tab-error",
      placement: "reserved title row",
    },
    {
      state: "Messages shows",
      script: () => undefined,
      channel: BOT_ID,
      shown: "stub-channel",
      placement: "title row",
    },
    {
      state: "Activity shows",
      script: () => useTracyPlaceStore.getState().setView(BOT_ID, "activity"),
      channel: BOT_ID,
      shown: "stub-activity",
      placement: "title row",
    },
    {
      state: "the channel is paused",
      script: () => {
        mocks.state.openResult = answer({
          kind: "paused",
          reason: "reachability-unknown",
        });
      },
      channel: BOT_ID,
      shown: "stub-channel",
      placement: "title row",
    },
    {
      state: "the stream failed after a snapshot",
      script: () => {
        mocks.state.error = "stream closed";
      },
      channel: BOT_ID,
      shown: "stub-channel",
      placement: "title row",
    },
  ])("draws it in the $placement while $state", (row) => {
    row.script();
    render(surfaceFor(row.channel));

    expect(screen.getByTestId(row.shown)).toBeTruthy();
    expectPlacement(row.placement);
  });

  it.each<readonly [string, () => void, string | null]>([
    [
      "no channel is selected",
      () => {
        mocks.state.listedBotIds = undefined;
      },
      null,
    ],
    ["a team's main bot is not listed", setUpNewTeam, SETUP_BOT_ID],
  ])(
    "draws a bar in the reserved title row, not a name, while %s",
    (_state, script, channel) => {
      script();
      render(surfaceFor(channel));

      expectPlacement("reserved title row");
      const header = screen.getByTestId("bot-channel-opening-header");
      expect(within(header).queryByRole("heading", { level: 1 })).toBeNull();
    },
  );

  it("names the bot in the reserved title row once the list does", () => {
    mocks.state.listTitles.set(BOT_ID, "Release Bot");
    mocks.state.openResult = null;
    render(surface());

    expectPlacement("reserved title row");
    const header = screen.getByTestId("bot-channel-opening-header");
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(
      "Release Bot",
    );
  });

  it("draws it in the channel header with the settings open, and with a re-open failed over the held answer", async () => {
    const user = userEvent.setup();
    const view = render(surface());
    await user.click(screen.getByTestId("bot-channel-settings-open"));
    expect(screen.getByTestId("stub-settings")).toBeTruthy();
    expectPlacement("title row");

    mocks.state.openResult = { kind: "error", message: "network down" };
    mocks.state.paneVisible = false;
    view.rerender(surface());
    mocks.state.paneVisible = true;
    view.rerender(surface());
    expect(screen.getByTestId("bot-tab-error")).toBeTruthy();
    expectPlacement("title row");
  });

  it("draws it in the session's header while a session shows, and in the channel's again on Back", async () => {
    const user = userEvent.setup();
    render(surface());
    expectPlacement("title row");

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(screen.queryByTestId("stub-channel")).toBeNull();
    expect(onlyGroup().header?.parentElement).toBe(
      screen.getByTestId("stub-session"),
    );

    await user.click(screen.getByTestId("stub-session-back"));
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    expectPlacement("title row");
  });

  it("keeps one group, in the same node, as a channel goes from no channel through its opening to open, never in a row", () => {
    mocks.state.listedBotIds = undefined;
    useTracySurfaceStore.setState({ botId: null });
    const view = render(surfaceFor(null));
    const seen = [{ placement: placementOf(), group: onlyGroup().group }];

    view.rerender(surfaceFor(BOT_ID));
    seen.push({ placement: placementOf(), group: onlyGroup().group });

    mocks.state.listedBotIds = [BOT_ID];
    view.rerender(surfaceFor(BOT_ID));
    expect(screen.getByTestId("stub-channel")).toBeTruthy();
    seen.push({ placement: placementOf(), group: onlyGroup().group });

    expect(seen.map((step) => step.placement)).toEqual([
      "reserved title row",
      "reserved title row",
      "title row",
    ]);
    expect(new Set(seen.map((step) => step.group)).size).toBe(1);
  });

  it("is never zero or two while the open channel goes to Threads, a session and back", async () => {
    const user = userEvent.setup();
    render(surface());
    expectPlacement("title row");

    await user.click(screen.getByTestId("stub-sidebar-threads"));
    expect(screen.getByTestId("stub-threads")).toBeTruthy();
    expectPlacement("threads title row");
    await user.click(screen.getByTestId("stub-threads-back"));
    expect(screen.queryByTestId("stub-threads")).toBeNull();
    expectPlacement("title row");

    await user.click(screen.getByTestId("stub-channel-open-turn"));
    expect(screen.getByTestId("stub-session")).toBeTruthy();
    expect(onlyGroup().header?.parentElement).toBe(
      screen.getByTestId("stub-session"),
    );
    await user.click(screen.getByTestId("stub-session-back"));
    expectPlacement("title row");
  });

  it("keeps the same mounted group, with its play state, as it moves between the row and the header", async () => {
    const user = userEvent.setup();
    render(surface());
    const before = onlyGroup().group;
    const pause = within(before).getByRole("button", { name: "Pause" });
    await user.click(pause);
    expect(within(before).getByRole("button", { name: "Play" })).toBeTruthy();

    await user.click(screen.getByTestId("stub-sidebar-threads"));
    expectPlacement("threads title row");
    expect(onlyGroup().group).toBe(before);

    await user.click(screen.getByTestId("stub-threads-back"));
    expectPlacement("title row");
    expect(onlyGroup().group).toBe(before);
    expect(within(before).getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("puts the header's buttons before Search", () => {
    render(surface());
    const search = screen.getByTestId("bot-channel-search-open");
    expect(
      onlyGroup().group.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
