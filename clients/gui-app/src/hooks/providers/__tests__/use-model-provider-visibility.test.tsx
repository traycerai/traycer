import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  methodSupported: true,
  version: { major: 10, minor: 10 },
  dataUpdatedAt: 1,
  isFetching: false,
  isPending: false,
  mutate: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.methodSupported,
  useHostMethodSchemaVersion: () => state.version,
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    dataUpdatedAt: state.dataUpdatedAt,
    isFetching: state.isFetching,
  }),
}));
vi.mock(
  "@/hooks/providers/use-providers-set-model-provider-hidden-mutation",
  () => ({
    useProvidersSetModelProviderHidden: () => ({
      mutate: state.mutate,
      isPending: state.isPending,
    }),
  }),
);

import { useModelProviderVisibility } from "../use-model-provider-visibility";

describe("useModelProviderVisibility", () => {
  beforeEach(() => {
    state.methodSupported = true;
    state.version = { major: 10, minor: 10 };
    state.dataUpdatedAt = 1;
    state.isFetching = false;
    state.isPending = false;
    state.mutate.mockReset();
  });

  it("requires the setter, list version, and field", () => {
    const { result, rerender } = renderHook(
      ({ stored }) =>
        useModelProviderVisibility({
          hostId: "h",
          providerId: "opencode",
          stored,
        }),
      { initialProps: { stored: [] as string[] | undefined } },
    );
    expect(result.current.supported).toBe(true);
    state.version = { major: 10, minor: 9 };
    rerender({ stored: [] });
    expect(result.current.supported).toBe(false);
    state.version = { major: 10, minor: 10 };
    state.methodSupported = false;
    rerender({ stored: [] });
    expect(result.current.supported).toBe(false);
    state.methodSupported = true;
    rerender({ stored: undefined });
    expect(result.current.supported).toBe(false);
  });

  it("holds a row echo until providers.list updates, then uses stored truth", () => {
    const { result, rerender } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: [],
      }),
    );
    act(() => result.current.setShown("openrouter", false));
    expect(state.mutate).toHaveBeenCalledWith(
      { harnessId: "opencode", modelProviderId: "openrouter", hidden: true },
      expect.any(Object),
    );
    expect(result.current.isShown("openrouter")).toBe(false);
    state.isFetching = true;
    rerender();
    expect(result.current.isSettling("openrouter")).toBe(true);
    state.dataUpdatedAt = 2;
    rerender();
    expect(result.current.isShown("openrouter")).toBe(true);
    expect(result.current.isSettling("openrouter")).toBe(false);
  });

  it("drops the optimistic echo when the mutation errors", () => {
    const { result } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: [],
      }),
    );
    act(() => result.current.setShown("openrouter", false));
    const options = state.mutate.mock.calls[0]?.[1] as { onError: () => void };
    act(() => options.onError());
    expect(result.current.isShown("openrouter")).toBe(true);
  });
});
