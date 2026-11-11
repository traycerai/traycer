import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  methodSupported: true,
  version: { major: 10, minor: 10 },
  dataUpdatedAt: 1,
  errorUpdatedAt: 0,
  mutateAsync: vi.fn(),
}));

vi.mock("@/hooks/host/use-host-supports-method", () => ({
  useHostMethodSupport: () => state.methodSupported,
  useHostMethodSchemaVersion: () => state.version,
}));
vi.mock("@/hooks/providers/use-providers-list-query", () => ({
  useProvidersList: () => ({
    dataUpdatedAt: state.dataUpdatedAt,
    errorUpdatedAt: state.errorUpdatedAt,
  }),
}));
vi.mock(
  "@/hooks/providers/use-providers-set-model-provider-hidden-mutation",
  () => ({
    useProvidersSetModelProviderHidden: () => ({
      mutateAsync: state.mutateAsync,
    }),
  }),
);

import { useModelProviderVisibility } from "../use-model-provider-visibility";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

function deferred(): Deferred {
  let resolvePromise: () => void = () => undefined;
  let rejectPromise: (reason: Error) => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe("useModelProviderVisibility", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100);
    state.methodSupported = true;
    state.version = { major: 10, minor: 10 };
    state.dataUpdatedAt = 1;
    state.errorUpdatedAt = 0;
    state.mutateAsync.mockReset();
  });

  it("requires the setter, list version, and field", () => {
    const initialProps: { readonly stored: string[] | undefined } = {
      stored: [],
    };
    const { result, rerender } = renderHook(
      ({ stored }) =>
        useModelProviderVisibility({
          hostId: "h",
          providerId: "opencode",
          stored,
        }),
      { initialProps },
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

  it("keeps a queued row hidden when another row's read lands", async () => {
    const first = deferred();
    const second = deferred();
    state.mutateAsync
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const initialProps: { readonly stored: string[] } = { stored: [] };
    const { result, rerender } = renderHook(
      ({ stored }) =>
        useModelProviderVisibility({
          hostId: "h",
          providerId: "opencode",
          stored,
        }),
      { initialProps },
    );

    act(() => {
      result.current.setShown("provider-a", false);
      result.current.setShown("provider-b", false);
    });
    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isShown("provider-b")).toBe(false);
    expect(result.current.isSettling("provider-b")).toBe(true);

    vi.setSystemTime(200);
    await act(async () => {
      first.resolve();
      await first.promise;
    });
    state.dataUpdatedAt = 200;
    rerender({ stored: ["provider-a"] });

    expect(result.current.isShown("provider-a")).toBe(false);
    expect(result.current.isSettling("provider-a")).toBe(false);
    expect(result.current.isShown("provider-b")).toBe(false);
    expect(result.current.isSettling("provider-b")).toBe(true);
  });

  it("releases a successful row echo after a read at or after its settlement", async () => {
    const write = deferred();
    state.mutateAsync.mockImplementation(() => write.promise);
    const { result, rerender } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: [],
      }),
    );
    act(() => result.current.setShown("provider-a", false));
    vi.setSystemTime(250);
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(result.current.isSettling("provider-a")).toBe(true);
    state.dataUpdatedAt = 250;
    rerender();
    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isSettling("provider-a")).toBe(false);
  });

  it("releases a successful row echo when a later providers.list read fails", async () => {
    const write = deferred();
    state.mutateAsync.mockImplementation(() => write.promise);
    const { result, rerender } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: [],
      }),
    );
    act(() => result.current.setShown("provider-a", false));
    vi.setSystemTime(300);
    await act(async () => {
      write.resolve();
      await write.promise;
    });
    state.errorUpdatedAt = 300;
    rerender();
    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isSettling("provider-a")).toBe(false);
  });

  it("a failed write reverts only its row", async () => {
    const failed = deferred();
    const pending = deferred();
    state.mutateAsync
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => pending.promise);
    const { result } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: ["provider-b"],
      }),
    );
    act(() => {
      result.current.setShown("provider-a", false);
      result.current.setShown("provider-b", true);
    });
    await act(async () => {
      failed.reject(new Error("write refused"));
      await failed.promise.catch(() => undefined);
    });
    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isShown("provider-b")).toBe(true);
    expect(result.current.isSettling("provider-b")).toBe(true);
  });

  it("ignores an older write settlement after a newer click on the same row", async () => {
    const older = deferred();
    const newer = deferred();
    state.mutateAsync
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const { result } = renderHook(() =>
      useModelProviderVisibility({
        hostId: "h",
        providerId: "opencode",
        stored: [],
      }),
    );
    act(() => result.current.setShown("provider-a", false));
    act(() => result.current.setShown("provider-a", true));
    expect(result.current.isShown("provider-a")).toBe(true);
    await act(async () => {
      older.resolve();
      await older.promise;
    });
    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isSettling("provider-a")).toBe(true);
    await act(async () => {
      newer.resolve();
      await newer.promise;
    });
    expect(result.current.isShown("provider-a")).toBe(true);
    expect(result.current.isSettling("provider-a")).toBe(true);
  });
});
