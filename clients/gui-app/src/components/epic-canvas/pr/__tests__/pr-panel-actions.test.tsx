import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
    usePrPanelStore.setState({ stateFilter: "open" });
  });
  afterEach(() => {
    cleanup();
    usePrPanelStore.setState({ stateFilter: "open" });
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

  it("names the listed state on the trigger and follows the store", () => {
    renderActions(subscription(data([])), true);
    const trigger = screen.getByTestId("pr-panel-state-filter");
    expect(trigger.textContent).toBe("Open");

    act(() => {
      usePrPanelStore.getState().setStateFilter("merged");
    });
    expect(trigger.textContent).toBe("Merged");
  });

  it("checks the stored filter among the four choices", async () => {
    usePrPanelStore.setState({ stateFilter: "closed" });
    renderActions(subscription(data([])), true);
    fireEvent.pointerDown(screen.getByTestId("pr-panel-state-filter"), {
      button: 0,
    });

    const items = await screen.findAllByRole("menuitemradio");
    expect(
      items.map((item) => [
        item.textContent,
        item.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["Open", "false"],
      ["Merged", "false"],
      ["Closed", "true"],
      ["All", "false"],
    ]);
  });

  it("sets the filter from the menu while the subscription is disabled", async () => {
    renderActions(subscription(data([])), false);
    const trigger = screen.getByTestId("pr-panel-state-filter");
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "All" }));

    expect(usePrPanelStore.getState().stateFilter).toBe("all");
    expect(trigger.textContent).toBe("All");
  });
});
