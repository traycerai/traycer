import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

interface HistoryRouteMatch {
  readonly search: Readonly<Record<string, string>>;
  readonly loaderData: { readonly historyNowMs: number };
}

interface NavigateArgs {
  readonly to: string;
  readonly replace: boolean;
  readonly search: (
    previous: Readonly<Record<string, string>>,
  ) => Readonly<Record<string, string | undefined>>;
}

const testState = vi.hoisted<{
  match: HistoryRouteMatch | null;
  navigate: Mock<(args: NavigateArgs) => void>;
}>(() => ({
  match: {
    search: { historyQuery: "api" },
    loaderData: { historyNowMs: 123 },
  },
  navigate: vi.fn<(args: NavigateArgs) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useMatch: ({ select }: { select: (match: HistoryRouteMatch) => unknown }) =>
    testState.match === null ? undefined : select(testState.match),
}));

vi.mock("@/components/epics/epics-list-panel", () => ({
  EpicsListPanel: (props: {
    readonly historyNowMs: number | null;
    readonly routeSearch: { readonly query: string } | null;
    readonly scope: string;
    readonly onScopeChange: (scope: string) => void;
  }) => (
    <div
      data-history-now={String(props.historyNowMs)}
      data-history-query={props.routeSearch?.query ?? ""}
      data-scope={props.scope}
      data-testid="history-list-probe"
    >
      <button type="button" onClick={() => props.onScopeChange("messages")}>
        pick messages
      </button>
      <button type="button" onClick={() => props.onScopeChange("all")}>
        pick all
      </button>
    </div>
  ),
}));

import { HistorySurface } from "@/components/epics/history-surface";

describe("<HistorySurface />", () => {
  afterEach(() => {
    cleanup();
    testState.navigate.mockReset();
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

  it("keeps the History filters when the route also carries a scope", () => {
    testState.match = {
      search: { historyQuery: "api", historyScope: "messages" },
      loaderData: { historyNowMs: 123 },
    };
    render(<HistorySurface />);

    expect(screen.getByTestId("history-list-probe").dataset.historyQuery).toBe(
      "api",
    );
  });

  it("reads the scope from the route, defaulting to all", () => {
    render(<HistorySurface />);
    expect(screen.getByTestId("history-list-probe").dataset.scope).toBe("all");
    cleanup();

    testState.match = {
      search: { historyQuery: "api", historyScope: "messages" },
      loaderData: { historyNowMs: 123 },
    };
    render(<HistorySurface />);
    expect(screen.getByTestId("history-list-probe").dataset.scope).toBe(
      "messages",
    );
  });

  it("writes a scope change to the route with replace, keeping the other params", () => {
    render(<HistorySurface />);

    fireEvent.click(screen.getByRole("button", { name: "pick messages" }));

    expect(testState.navigate).toHaveBeenCalledTimes(1);
    const args = testState.navigate.mock.calls[0][0];
    expect(args.to).toBe("/epics");
    expect(args.replace).toBe(true);
    expect(args.search({ historyQuery: "api" })).toEqual({
      historyQuery: "api",
      historyScope: "messages",
    });
  });

  it("drops the param when the scope returns to all", () => {
    render(<HistorySurface />);

    fireEvent.click(screen.getByRole("button", { name: "pick all" }));

    const args = testState.navigate.mock.calls[0][0];
    expect(
      args.search({ historyQuery: "api", historyScope: "messages" })
        .historyScope,
    ).toBeUndefined();
  });
});
