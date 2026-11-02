import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import {
  displayNotificationRows,
  type NotificationDisplayTarget,
} from "@/lib/notifications/notification-display";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";
import type { NotificationShowOutcome } from "@traycer-clients/shared/platform/runner-host";
import {
  EMPTY_DIRECTORY_STATE,
  ONE_TEAM_MAIN_BOT_DIRECTORY,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const NOTIFICATION: MergedNotificationRow = {
  feedId: "host:n-1",
  source: "host",
  sourceId: "n-1",
  originHostId: null,
  createdAt: 10,
  readAt: null,
  title: "Checkout notifications",
  body: "New chat • Done",
  payload: { kind: "chat", epicId: "epic-1", chatId: "chat-1" },
  hostKind: "agent.stopped",
  appLocalKind: null,
  globalEntry: null,
  severity: "done",
  outcome: "completed",
  resolvedAt: null,
  sourceRef: null,
  category: "task",
};

const BOT_NOTIFICATION: MergedNotificationRow = {
  ...NOTIFICATION,
  title: "Tracy",
  body: "Tracy answered • The release is out",
  payload: {
    kind: "chat",
    epicId: TEAM_MAIN_BOT_ID,
    chatId: "thread-1",
    bot: {
      botId: TEAM_MAIN_BOT_ID,
      threadId: "thread-1",
      messageId: "message-1",
    },
  },
};

describe("notification toast interactions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
    // The in-app toast only renders in a focused window; jsdom reports
    // unfocused by default.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("activates when the rendered toast surface is clicked", async () => {
    const onToastClick = vi.fn<NotificationDisplayTarget["onToastClick"]>();
    render(<Toaster />);

    act(() => {
      displayNotificationRows(
        [NOTIFICATION],
        {
          showNotification: vi.fn(() =>
            Promise.resolve<NotificationShowOutcome>("presented"),
          ),
          playChime: vi.fn(),
          onToastClick,
        },
        null,
      );
    });

    const title = await screen.findByText("Checkout notifications");
    const toastSurface = title.closest("[data-sonner-toast]");

    expect(toastSurface).not.toBeNull();
    if (toastSurface === null) return;

    fireEvent.click(toastSurface);

    expect(onToastClick).toHaveBeenCalledOnce();
    expect(onToastClick).toHaveBeenCalledWith(NOTIFICATION);
  });

  it("names a team's bot with its environment on the toast and the native notification when two main bots are visible", async () => {
    useStandaloneBotsStore.setState({
      directory: TWO_MAIN_BOTS_DIRECTORY,
      settled: true,
    });
    const showNotification = vi.fn<
      NotificationDisplayTarget["showNotification"]
    >(() => Promise.resolve<NotificationShowOutcome>("presented"));
    render(<Toaster />);

    act(() => {
      displayNotificationRows(
        [BOT_NOTIFICATION],
        { showNotification, playChime: vi.fn(), onToastClick: vi.fn() },
        null,
      );
    });

    expect(await screen.findByText("Tracy · traycerai")).toBeTruthy();
    expect(showNotification.mock.calls[0]?.[0].title).toBe("Tracy · traycerai");
  });

  it("keeps a bot's plain name on the toast when one main bot is visible", async () => {
    useStandaloneBotsStore.setState({
      directory: ONE_TEAM_MAIN_BOT_DIRECTORY,
      settled: true,
    });
    render(<Toaster />);

    act(() => {
      displayNotificationRows(
        [BOT_NOTIFICATION],
        {
          showNotification: vi.fn(() =>
            Promise.resolve<NotificationShowOutcome>("presented"),
          ),
          playChime: vi.fn(),
          onToastClick: vi.fn(),
        },
        null,
      );
    });

    expect(await screen.findByText("Tracy")).toBeTruthy();
  });

  it("does not activate when the close control is clicked", async () => {
    const onToastClick = vi.fn<NotificationDisplayTarget["onToastClick"]>();
    render(<Toaster />);

    act(() => {
      displayNotificationRows(
        [NOTIFICATION],
        {
          showNotification: vi.fn(() =>
            Promise.resolve<NotificationShowOutcome>("presented"),
          ),
          playChime: vi.fn(),
          onToastClick,
        },
        null,
      );
    });

    const closeToastButton = await screen.findByRole("button", {
      name: "Close toast",
    });
    fireEvent.click(closeToastButton);

    expect(onToastClick).not.toHaveBeenCalled();
  });
});
