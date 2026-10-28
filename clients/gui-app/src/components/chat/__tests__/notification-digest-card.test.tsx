import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChatNotificationDigestRow,
  ChatQueuedNotificationDigestItem,
} from "@traycer/protocol/host/agent/gui/subscribe";
import { NotificationDigestCard } from "@/components/chat/notification-digest-card";

function row(
  notificationId: string,
  title: string,
  overrides: Partial<ChatNotificationDigestRow>,
): ChatNotificationDigestRow {
  return {
    notificationId,
    entity: null,
    severity: "info",
    operation: "completed",
    title,
    at: 1,
    read: false,
    ...overrides,
  };
}

function digest(
  overrides: Partial<ChatQueuedNotificationDigestItem>,
): ChatQueuedNotificationDigestItem {
  return {
    kind: "notification-digest",
    queueItemId: "queue-digest",
    description: "Notification digest",
    delivery: "next_turn",
    targetTurnId: null,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    window: { fromVersion: 0, throughVersion: 4, from: 1, through: 2 },
    attention: [],
    recent: null,
    truncated: false,
    ...overrides,
  };
}

const ATTENTION = row("n-1", "The release run failed", {
  entity: { kind: "task", id: "task-1", title: "Ship the release" },
  severity: "error",
  operation: "failed",
});
const RECENT_ONE = row("n-2", "Nightly finished", {
  entity: { kind: "bot", id: "bot-1", title: null },
  read: true,
});
const RECENT_TWO = row("n-3", "Review requested", {
  entity: { kind: "chat", id: "chat-1", title: "Planning" },
});

afterEach(() => {
  cleanup();
});

describe("<NotificationDigestCard />", () => {
  it("shows an attention row on one line with the entity it names, and holds the recent rows behind a count", async () => {
    const user = userEvent.setup();
    render(
      <NotificationDigestCard
        item={digest({
          attention: [ATTENTION],
          recent: [RECENT_ONE, RECENT_TWO],
          truncated: true,
        })}
      />,
    );

    const [attentionRow] = screen.getAllByTestId("notification-digest-row");
    expect(
      within(attentionRow).getByText("The release run failed"),
    ).toBeTruthy();
    expect(
      within(attentionRow).getByTestId("notification-digest-entity")
        .textContent,
    ).toBe("Task: Ship the release");

    const toggle = screen.getByRole("button", { name: "2 more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Nightly finished")).toBeNull();
    expect(screen.queryByText("Review requested")).toBeNull();
    expect(screen.getAllByTestId("notification-digest-row")).toHaveLength(1);

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nightly finished")).toBeTruthy();
    expect(screen.getByText("Review requested")).toBeTruthy();
    const entityChips = screen
      .getAllByTestId("notification-digest-entity")
      .map((chip) => chip.textContent);
    expect(entityChips).toEqual([
      "Task: Ship the release",
      "Bot",
      "Chat: Planning",
    ]);

    expect(
      screen.getByText("The rest follows in the next digest"),
    ).toBeTruthy();
  });

  it("shows no more-toggle, and no note, for an attention-only digest that fit", () => {
    render(
      <NotificationDigestCard
        item={digest({ attention: [ATTENTION], recent: null })}
      />,
    );

    expect(screen.getByText("The release run failed")).toBeTruthy();
    expect(
      screen.queryByTestId("notification-digest-recent-toggle"),
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      screen.queryByText("The rest follows in the next digest"),
    ).toBeNull();
  });

  it("says nothing needs the person when only recent rows arrived, and still offers them", async () => {
    const user = userEvent.setup();
    render(
      <NotificationDigestCard
        item={digest({ attention: [], recent: [RECENT_ONE] })}
      />,
    );

    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.queryAllByTestId("notification-digest-row")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "1 more" }));
    expect(screen.getByText("Nightly finished")).toBeTruthy();
  });

  it("shows no toggle when the recent list is empty", () => {
    render(
      <NotificationDigestCard
        item={digest({ attention: [ATTENTION], recent: [] })}
      />,
    );

    expect(
      screen.queryByTestId("notification-digest-recent-toggle"),
    ).toBeNull();
  });

  it("shows a row that addresses nothing without an entity chip", () => {
    render(
      <NotificationDigestCard
        item={digest({ attention: [row("n-9", "Host updated", {})] })}
      />,
    );

    expect(screen.getByText("Host updated")).toBeTruthy();
    expect(screen.queryByTestId("notification-digest-entity")).toBeNull();
  });
});
