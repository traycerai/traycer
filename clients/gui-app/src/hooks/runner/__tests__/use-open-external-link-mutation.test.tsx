import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RunnerHostContext } from "@/providers/runner-host-context";
import { useRunnerOpenExternalLink } from "../use-open-external-link-mutation";

const mocks = vi.hoisted(() => ({ toastFromRunnerError: vi.fn() }));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: mocks.toastFromRunnerError,
}));

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.test/sign-in",
    authnBaseUrl: "https://auth.traycer.test",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function createWrapper(host: IRunnerHost | null) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return function RunnerMutationWrapper(props: {
    readonly children: ReactNode;
  }) {
    return (
      <QueryClientProvider client={queryClient}>
        <RunnerHostContext.Provider value={host}>
          {props.children}
        </RunnerHostContext.Provider>
      </QueryClientProvider>
    );
  };
}

describe("useRunnerOpenExternalLink", () => {
  it("rejects and maps an error when the runner host is unavailable", async () => {
    const { result } = renderHook(useRunnerOpenExternalLink, {
      wrapper: createWrapper(null),
    });

    await expect(
      result.current.mutateAsync("https://example.com"),
    ).rejects.toThrow("desktop link opener is unavailable");
    expect(mocks.toastFromRunnerError).toHaveBeenCalledWith(
      expect.any(Error),
      "Couldn't open link",
    );
  });

  it("maps runner bridge failures", async () => {
    const host = createRunnerHost();
    const failure = new Error("bridge failed");
    vi.spyOn(host, "openExternalLink").mockRejectedValue(failure);
    const { result } = renderHook(useRunnerOpenExternalLink, {
      wrapper: createWrapper(host),
    });

    await expect(
      result.current.mutateAsync("https://example.com"),
    ).rejects.toThrow("bridge failed");
    expect(mocks.toastFromRunnerError).toHaveBeenCalledWith(
      failure,
      "Couldn't open link",
    );
  });

  it("reports pending until the runner bridge settles", async () => {
    const host = createRunnerHost();
    let resolveBridge: () => void = () => undefined;
    const bridge = new Promise<void>((resolve) => {
      resolveBridge = resolve;
    });
    vi.spyOn(host, "openExternalLink").mockImplementation(() => bridge);
    const { result } = renderHook(useRunnerOpenExternalLink, {
      wrapper: createWrapper(host),
    });

    let mutation = Promise.resolve();
    act(() => {
      mutation = result.current.mutateAsync("https://example.com");
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    resolveBridge();
    await act(async () => mutation);

    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
