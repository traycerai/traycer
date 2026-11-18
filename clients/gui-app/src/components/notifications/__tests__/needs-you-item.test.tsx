import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NeedsYouItem } from "@/components/notifications/needs-you-item";
import type { NeedsYouItem as NeedsYouItemData } from "@/stores/notifications/needs-you-items";
import type { MergedNotificationRow } from "@/stores/notifications/merged-notifications";

const ROW = { feedId: "host:approval-1" } as MergedNotificationRow;

function buildItem(overrides: Partial<NeedsYouItemData>): NeedsYouItemData {
  return {
    row: ROW,
    reason: "approval",
    ask: "Approval requested",
    taskTitle: "Deploy checkout fix",
    agentTitle: "Deploy agent",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("<NeedsYouItem />", () => {
  afterEach(cleanup);

  it("renders as one button carrying the reason, and activates on click", () => {
    const onActivate = vi.fn();
    render(<NeedsYouItem item={buildItem({})} onActivate={onActivate} />);

    const button = screen.getByTestId("needs-you-item");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("data-needs-you-reason")).toBe("approval");
    expect(button.getAttribute("data-notification-id")).toBe("host:approval-1");
    expect(button.textContent).toContain("Approval requested");
    expect(button.textContent).toContain("Deploy checkout fix · Deploy agent");

    fireEvent.click(button);
    expect(onActivate).toHaveBeenCalledWith(ROW);
  });

  it("gives approval and reply distinct icons, not colour alone", () => {
    const { rerender } = render(
      <NeedsYouItem
        item={buildItem({ reason: "approval" })}
        onActivate={() => undefined}
      />,
    );
    expect(
      screen
        .getByTestId("needs-you-item")
        .querySelector('[data-status-glyph="approval"]'),
    ).not.toBeNull();

    rerender(
      <NeedsYouItem
        item={buildItem({ reason: "reply" })}
        onActivate={() => undefined}
      />,
    );
    expect(
      screen
        .getByTestId("needs-you-item")
        .querySelector('[data-status-glyph="interview"]'),
    ).not.toBeNull();
  });

  it("falls back to the task title alone when there is no agent title", () => {
    render(
      <NeedsYouItem
        item={buildItem({ agentTitle: null })}
        onActivate={() => undefined}
      />,
    );

    const button = screen.getByTestId("needs-you-item");
    expect(button.textContent).toContain("Deploy checkout fix");
    expect(button.textContent).not.toContain("·");
  });
});
