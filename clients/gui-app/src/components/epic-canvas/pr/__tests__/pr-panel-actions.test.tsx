import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { PrLightItem } from "@traycer/protocol/host/pr-schemas";
import type {
  PrListSubscriptionData,
  PrListSubscriptionResult,
} from "@/hooks/pr/use-pr-list-subscription";
import { PrPanelActions } from "@/components/epic-canvas/pr/pr-panel-actions";

function buildPrItem(overrides: Partial<PrLightItem>): PrLightItem {
  return {
    githubHost: null,
    base: null,
    prUrl: null,
    state: "open",
    liveness: "live",
    observedAt: null,
    isDraft: false,
    title: "Test PR",
    baseRefName: "main",
    headRefName: "feature/test",
    additions: 10,
    deletions: 2,
    checksRollup: null,
    reviewDecision: null,
    commentCount: 0,
    updatedAt: 1_000,
    repoIdentifier: { owner: "acme", repo: "widgets" },
    repoRole: "superproject",
    linkGroupKey: null,
    owners: [],
    ...overrides,
  };
}

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
  afterEach(cleanup);

  it("renders freshness from the subscription supplied by the panel body", () => {
    renderActions(
      subscription(data([buildPrItem({ observedAt: null })])),
      true,
    );
    expect(screen.getByTestId("pr-panel-staleness").textContent).toBe(
      "Not yet fetched",
    );
  });

  it("renders an updated label when the selected host reports an observation", () => {
    renderActions(
      subscription(data([buildPrItem({ observedAt: 1_000 })])),
      true,
    );
    expect(screen.getByTestId("pr-panel-staleness").textContent).toMatch(
      /^Updated /,
    );
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
});
