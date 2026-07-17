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

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

const NOTIFICATION: MergedNotificationRow = {
  feedId: "host:n-1",
  source: "host",
  sourceId: "n-1",
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
};

describe("notification toast interactions", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    vi.useRealTimers();
  });

  it("activates when the rendered toast surface is clicked", async () => {
    const onToastClick = vi.fn<NotificationDisplayTarget["onToastClick"]>();
    render(<Toaster />);

    act(() => {
      displayNotificationRows([NOTIFICATION], {
        showNotification: vi.fn(() => Promise.resolve()),
        playChime: vi.fn(),
        onToastClick,
      });
    });

    const title = await screen.findByText("Checkout notifications");
    const toastSurface = title.closest("[data-sonner-toast]");

    expect(toastSurface).not.toBeNull();
    if (toastSurface === null) return;

    const beforeClick = Date.now();
    fireEvent.click(toastSurface);

    expect(onToastClick).toHaveBeenCalledOnce();
    expect(onToastClick).toHaveBeenCalledWith(NOTIFICATION, expect.any(Number));
    const activatedAt = onToastClick.mock.calls[0]?.[1];
    expect(activatedAt).toBeGreaterThanOrEqual(beforeClick);
    expect(activatedAt).not.toBe(NOTIFICATION.createdAt);
  });

  it("does not activate when the close control is clicked", async () => {
    const onToastClick = vi.fn<NotificationDisplayTarget["onToastClick"]>();
    render(<Toaster />);

    act(() => {
      displayNotificationRows([NOTIFICATION], {
        showNotification: vi.fn(() => Promise.resolve()),
        playChime: vi.fn(),
        onToastClick,
      });
    });

    const closeToastButton = await screen.findByRole("button", {
      name: "Close toast",
    });
    fireEvent.click(closeToastButton);

    expect(onToastClick).not.toHaveBeenCalled();
  });
});
