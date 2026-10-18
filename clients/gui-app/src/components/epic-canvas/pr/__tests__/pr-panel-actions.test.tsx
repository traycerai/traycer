import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import type {
  PrListSubscriptionData,
  PrListSubscriptionResult,
} from "@/hooks/pr/use-pr-list-subscription";
import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";
import { usePrPanelStore } from "@/stores/epics/pr-panel-store";

function data(items: readonly PrLightItem[]): PrListSubscriptionData {
  return { sourceStatus: "ok", notice: null, items };
}

interface TestSubscription {
  readonly data: PrListSubscriptionData | null;
  readonly error: PrListSubscriptionResult["error"];
  readonly isPending: boolean;
  readonly sendRefresh: Mock<() => void>;
}

function subscription(value: PrListSubscriptionData | null): TestSubscription {
  return {
    data: value,
    error: null,
    isPending: value === null,
    sendRefresh: vi.fn(),
  };
}

function renderActions(value: TestSubscription, enabled: boolean): void {
  render(<PrPanelActions subscription={value} enabled={enabled} />);
}

describe("PrPanelActions", () => {
  beforeEach(() => {
    usePrPanelStore.setState({ openOnly: false });
  });
  afterEach(() => {
    cleanup();
    usePrPanelStore.setState({ openOnly: false });
  });

  it("sends refresh through the exact subscription instance passed by the body", () => {
    const current = subscription(data([]));
    renderActions(current, true);
    fireEvent.click(screen.getByTestId("pr-panel-refresh"));
    expect(current.sendRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps refresh disabled when the shared panel subscription is not enabled", () => {
    const current = subscription(data([]));
    renderActions(current, false);
    expect(
      screen.getByTestId("pr-panel-refresh").getAttribute("disabled"),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId("pr-panel-refresh"));
    expect(current.sendRefresh).not.toHaveBeenCalled();
  });

  it("toggles the open-only filter and reflects it as pressed", () => {
    renderActions(subscription(data([])), true);
    const toggle = screen.getByTestId("pr-panel-open-only");
    expect(toggle.getAttribute("aria-label")).toBe(
      "Show open pull requests only",
    );
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);
    expect(usePrPanelStore.getState().openOnly).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);
    expect(usePrPanelStore.getState().openOnly).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the open-only filter usable when the subscription is disabled", () => {
    renderActions(subscription(data([])), false);
    const toggle = screen.getByTestId("pr-panel-open-only");
    expect(toggle.getAttribute("disabled")).toBeNull();

    fireEvent.click(toggle);
    expect(usePrPanelStore.getState().openOnly).toBe(true);
  });
});
