import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { useOpenExternalLink } from "@/lib/links/open-external-link";
import { RunnerHostContext } from "@/providers/runner-host-context";

const toastFromRunnerError = vi.hoisted(() =>
  vi.fn<(error: unknown, fallback: string) => void>(),
);
vi.mock("@/lib/runner-error-toast", () => ({ toastFromRunnerError }));

const URL_UNDER_TEST = "https://example.test/docs";

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.example/sign-in",
    authnBaseUrl: "https://auth.example",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderBridge(runnerHost: IRunnerHost | null) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  function wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <QueryClientProvider client={queryClient}>
        <RunnerHostContext value={runnerHost}>
          {props.children}
        </RunnerHostContext>
      </QueryClientProvider>
    );
  }
  return renderHook(() => useOpenExternalLink(), { wrapper }).result;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useOpenExternalLink", () => {
  it("toasts and rejects with no runner host bound", async () => {
    const result = renderBridge(null);

    await expect(result.current.mutateAsync(URL_UNDER_TEST)).rejects.toThrow(
      "The desktop link opener is unavailable.",
    );
    expect(toastFromRunnerError).toHaveBeenCalledWith(
      expect.any(Error),
      "Couldn't open link",
    );
  });

  it("toasts and rejects when the bridge refuses", async () => {
    const cause = new Error("no browser on this machine");
    const host = createRunnerHost();
    host.openExternalLink = () => Promise.reject(cause);
    const result = renderBridge(host);

    await expect(result.current.mutateAsync(URL_UNDER_TEST)).rejects.toBe(
      cause,
    );
    expect(toastFromRunnerError).toHaveBeenCalledWith(
      cause,
      "Couldn't open link",
    );
  });

  it("resolves quietly on a successful handoff", async () => {
    const host = createRunnerHost();
    const result = renderBridge(host);

    await expect(
      result.current.mutateAsync(URL_UNDER_TEST),
    ).resolves.toBeUndefined();
    expect(host.openedExternalLinks).toEqual([URL_UNDER_TEST]);
    expect(toastFromRunnerError).not.toHaveBeenCalled();
  });

  // The pending flag is what the link surfaces disable on (R10), so it has to
  // be true for the whole handoff and false again once it settles.
  it("reports isPending while the handoff is outstanding", async () => {
    let release = (): void => undefined;
    const host = createRunnerHost();
    host.openExternalLink = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const result = renderBridge(host);

    expect(result.current.isPending).toBe(false);
    let handoff: Promise<void> = Promise.resolve();
    act(() => {
      handoff = result.current.mutateAsync(URL_UNDER_TEST);
    });
    await waitFor(() => {
      expect(result.current.isPending).toBe(true);
    });

    await act(async () => {
      release();
      await handoff;
    });
    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
    });
  });
});
