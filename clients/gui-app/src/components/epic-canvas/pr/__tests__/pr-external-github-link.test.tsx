import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { PrExternalGitHubLink } from "@/components/epic-canvas/pr/pr-external-github-link";
import { RunnerHostContext } from "@/providers/runner-host-context";

const HREF = "https://github.com/acme/widgets/pull/7";

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
}

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

function renderLink(runnerHost: MockRunnerHost | null): void {
  render(
    <QueryClientProvider client={newQueryClient()}>
      <RunnerHostContext.Provider value={runnerHost}>
        <PrExternalGitHubLink
          href={HREF}
          className="link"
          testId="pr-external-github-link"
        >
          View on GitHub
        </PrExternalGitHubLink>
      </RunnerHostContext.Provider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("PrExternalGitHubLink", () => {
  it("routes a click through the RunnerHost bridge exactly once, and prevents the native navigation", async () => {
    const host = createRunnerHost();
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockResolvedValue(undefined);
    renderLink(host);

    const link = screen.getByTestId<HTMLAnchorElement>(
      "pr-external-github-link",
    );
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    // `waitFor` rather than a zero-delay timer flush: `mutate` invokes the
    // mutation function asynchronously, so the call lands after a microtask.
    await waitFor(() => {
      expect(openExternalLink).toHaveBeenCalledTimes(1);
    });
    expect(openExternalLink).toHaveBeenCalledWith(HREF);
  });

  it("is a no-op with no RunnerHost bound: native new-tab navigation survives", () => {
    renderLink(null);

    const link = screen.getByTestId<HTMLAnchorElement>(
      "pr-external-github-link",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe(HREF);

    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    link.dispatchEvent(event);

    // The handler must not have called `preventDefault` - the web client has
    // no bridge to route through, so blocking it would break the link.
    expect(event.defaultPrevented).toBe(false);
  });

  it("drops a second click fired while the first bridge request is still in flight", async () => {
    const host = createRunnerHost();
    let resolveOpen: (() => void) | undefined;
    const openExternalLink = vi
      .spyOn(host, "openExternalLink")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveOpen = resolve;
          }),
      );
    renderLink(host);

    const link = screen.getByTestId("pr-external-github-link");
    fireEvent.click(link);

    // Wait for the first request to actually be in flight (`isPending` true)
    // before firing the second click, so the second click's handler closure
    // observes the pending mutation rather than racing its dispatch.
    await waitFor(() => {
      expect(openExternalLink).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(link);

    // `mutate` dispatches through a microtask, so a second, unwanted call
    // would not show up in a synchronous assertion right after the click -
    // flush the macrotask queue before asserting it never landed.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(openExternalLink).toHaveBeenCalledTimes(1);

    resolveOpen?.();
  });
});
