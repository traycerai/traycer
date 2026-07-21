import "../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

interface HistoryRouteMatch {
  readonly search: { readonly historyQuery: string };
  readonly loaderData: { readonly historyNowMs: number };
}

const testState = vi.hoisted<{ match: HistoryRouteMatch | null }>(() => ({
  match: {
    search: { historyQuery: "api" },
    loaderData: { historyNowMs: 123 },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useMatch: ({ select }: { select: (match: HistoryRouteMatch) => unknown }) =>
    testState.match === null ? undefined : select(testState.match),
}));

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: (props: {
    readonly historyNowMs: number | null;
    readonly routeSearch: { readonly query: string } | null;
  }) => (
    <div
      data-history-now={String(props.historyNowMs)}
      data-history-query={props.routeSearch?.query ?? ""}
      data-testid="history-list-probe"
    />
  ),
}));

import { HistorySurface } from "@/components/epics/history-surface";

describe("<HistorySurface />", () => {
  afterEach(() => {
    testState.match = {
      search: { historyQuery: "api" },
      loaderData: { historyNowMs: 123 },
    };
  });

  it("preserves the canonical History route filters and loader clock", () => {
    const view = render(<HistorySurface />);

    const probe = screen.getByTestId("history-list-probe");
    expect(probe.dataset.historyQuery).toBe("api");
    expect(probe.dataset.historyNow).toBe("123");

    testState.match = null;
    view.rerender(<HistorySurface />);

    expect(probe.dataset.historyQuery).toBe("api");
    expect(probe.dataset.historyNow).toBe("123");
  });
});
