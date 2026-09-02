import type { ReactNode } from "react";
import { cleanup, renderHook } from "@testing-library/react";
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
  function wrapper(props: { readonly children: ReactNode }): ReactNode {
    return (
      <RunnerHostContext value={runnerHost}>{props.children}</RunnerHostContext>
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
    const { current: openExternalLink } = renderBridge(null);

    await expect(openExternalLink(URL_UNDER_TEST)).rejects.toThrow(
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
    const { current: openExternalLink } = renderBridge(host);

    await expect(openExternalLink(URL_UNDER_TEST)).rejects.toBe(cause);
    expect(toastFromRunnerError).toHaveBeenCalledWith(
      cause,
      "Couldn't open link",
    );
  });

  it("resolves quietly on a successful handoff", async () => {
    const host = createRunnerHost();
    const { current: openExternalLink } = renderBridge(host);

    await expect(openExternalLink(URL_UNDER_TEST)).resolves.toBeUndefined();
    expect(host.openedExternalLinks).toEqual([URL_UNDER_TEST]);
    expect(toastFromRunnerError).not.toHaveBeenCalled();
  });
});
