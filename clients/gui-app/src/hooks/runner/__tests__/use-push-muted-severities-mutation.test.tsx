import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IPushPermissionHost,
  PushSeverity,
} from "@traycer-clients/shared/platform/runner-host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { useAuthStore } from "@/stores/auth/auth-store";
import { createFakeRunnerHost } from "../../../../__tests__/create-fake-runner-host";
import {
  usePushMutedSeveritiesMutation,
  type PushMutedSeveritiesMutation,
} from "../use-push-muted-severities-mutation";

const toast = vi.hoisted(() => ({
  error: vi.fn<(message: unknown) => string | number>(() => 1),
}));

vi.mock("sonner", () => ({ toast }));

function signInAs(userId: string): void {
  act(() => {
    useAuthStore
      .getState()
      .setSignedIn(
        { userId, userName: userId, email: `${userId}@example.com` },
        { userId, username: userId },
        [],
      );
  });
}

function pushHost(
  setMutedSeverities: (set: readonly PushSeverity[]) => Promise<void>,
): IPushPermissionHost {
  return {
    get: () => Promise.resolve("granted"),
    request: () => Promise.resolve("granted"),
    openSettings: () => Promise.resolve(),
    getMutedSeverities: () => Promise.resolve([]),
    setMutedSeverities,
    onChange: () => ({ dispose: () => undefined }),
  };
}

function renderMutation(host: IPushPermissionHost): {
  readonly result: { readonly current: PushMutedSeveritiesMutation };
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <RunnerHostProvider
        runnerHost={createFakeRunnerHost({ pushPermission: host })}
      >
        {props.children}
      </RunnerHostProvider>
    </QueryClientProvider>
  );
  return renderHook(() => usePushMutedSeveritiesMutation(), { wrapper });
}

beforeEach(() => {
  toast.error.mockClear();
  signInAs("A");
});

afterEach(() => {
  cleanup();
  useAuthStore.getState().setSignedOut();
});

describe("usePushMutedSeveritiesMutation", () => {
  it("writes the set while the account it was derived from is still signed in", async () => {
    const written: Array<readonly PushSeverity[]> = [];
    const { result } = renderMutation(
      pushHost((set) => {
        written.push(set);
        return Promise.resolve();
      }),
    );

    act(() => {
      result.current.mutate({ userId: "A", severities: ["done"] });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(written).toEqual([["done"]]);
  });

  it("writes nothing and raises no toast once another account is signed in", async () => {
    const setMutedSeverities = vi.fn((): Promise<void> => Promise.resolve());
    const { result } = renderMutation(pushHost(setMutedSeverities));
    signInAs("B");

    act(() => {
      result.current.mutate({ userId: "A", severities: ["done"] });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(setMutedSeverities).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("raises its toast for a failed write by the signed-in account", async () => {
    const { result } = renderMutation(
      pushHost(() => Promise.reject(new Error("storage full"))),
    );

    act(() => {
      result.current.mutate({ userId: "A", severities: ["done"] });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
  });

  it("drops the toast of a write that failed after another account signed in", async () => {
    const gate: { fail: (error: Error) => void } = { fail: () => undefined };
    const setMutedSeverities = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          gate.fail = reject;
        }),
    );
    const { result } = renderMutation(pushHost(setMutedSeverities));

    act(() => {
      result.current.mutate({ userId: "A", severities: ["done"] });
    });
    await waitFor(() => {
      expect(setMutedSeverities).toHaveBeenCalledTimes(1);
    });
    signInAs("B");
    gate.fail(new Error("storage full"));

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
