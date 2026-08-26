import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAmbientHistorySearchState,
  useRouteHistorySearchState,
} from "@/hooks/home/use-history-search-state";
import { useHistorySearchStore } from "@/stores/home/history-search-store";
import {
  DEFAULT_HISTORY_SEARCH,
  type HistorySearchState,
} from "@/lib/history-search";

interface NavigateArgs {
  readonly to: string;
  readonly search: (prev: Record<string, unknown>) => Record<string, unknown>;
}

const routerState = vi.hoisted(() => ({
  navigate: vi.fn<(args: NavigateArgs) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: routerState.navigate }),
}));

describe("history search state hooks", () => {
  beforeEach(() => {
    routerState.navigate.mockClear();
    window.localStorage.clear();
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  it("ambient surfaces (routeSearch=null) update the persisted store, not the URL", () => {
    const { result } = renderHook(() => useAmbientHistorySearchState());

    act(() => {
      result.current.update({ query: "api" });
    });
    act(() => {
      result.current.update({ ownershipScopes: ["shared"] });
    });

    expect(routerState.navigate).not.toHaveBeenCalled();
    expect(useHistorySearchStore.getState().search).toMatchObject({
      query: "api",
      ownershipScopes: ["shared"],
    });
    expect(result.current.search).toMatchObject({
      query: "api",
      ownershipScopes: ["shared"],
    });
  });

  it("clear() resets the store for ambient surfaces", () => {
    useHistorySearchStore.setState({
      search: { ...DEFAULT_HISTORY_SEARCH, query: "stale" },
    });
    const { result } = renderHook(() => useAmbientHistorySearchState());

    act(() => {
      result.current.clear();
    });

    expect(useHistorySearchStore.getState().search).toEqual(
      DEFAULT_HISTORY_SEARCH,
    );
  });

  it("route surfaces (/epics) navigate the URL; the store follows route state, not the patch", () => {
    const { result } = renderHook(() =>
      useRouteHistorySearchState(DEFAULT_HISTORY_SEARCH),
    );

    act(() => {
      result.current.update({ query: "api" });
    });

    expect(routerState.navigate).toHaveBeenCalledTimes(1);
    const navigateArgs = routerState.navigate.mock.calls[0][0];
    expect(navigateArgs.search({})).toMatchObject({ historyQuery: "api" });
    // The patch itself never writes the store - the mirror rides the route
    // state, which this mocked router never re-delivers.
    expect(useHistorySearchStore.getState().search).toEqual(
      DEFAULT_HISTORY_SEARCH,
    );
  });

  it("route surfaces mirror the route state into the store (memory adoption)", () => {
    const routeSearch: HistorySearchState = {
      ...DEFAULT_HISTORY_SEARCH,
      query: "deep-linked",
      ownershipScopes: ["mine"],
    };
    const { rerender } = renderHook(
      (props: { search: HistorySearchState }) =>
        useRouteHistorySearchState(props.search),
      { initialProps: { search: routeSearch } },
    );

    expect(useHistorySearchStore.getState().search).toMatchObject({
      query: "deep-linked",
      ownershipScopes: ["mine"],
    });

    const nextRouteSearch = { ...DEFAULT_HISTORY_SEARCH, query: "narrowed" };
    rerender({ search: nextRouteSearch });

    expect(useHistorySearchStore.getState().search).toMatchObject({
      query: "narrowed",
      ownershipScopes: [],
    });
  });

  it("route surfaces do not subscribe to ambient history store changes", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useRouteHistorySearchState(DEFAULT_HISTORY_SEARCH);
    });
    const rendersBeforeAmbientUpdate = renderCount;

    act(() => {
      useHistorySearchStore.getState().update({ query: "modal-only" });
    });

    expect(renderCount).toBe(rendersBeforeAmbientUpdate);
    expect(result.current.search).toEqual(DEFAULT_HISTORY_SEARCH);
  });
});
