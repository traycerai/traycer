import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostRuntimeProvider, hostRpcRegistry } from "@/lib/host";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * Real `HostRuntimeProvider` startup (`messengerFactory` is `null`, as desktop). Wait on a timer that resolves, not throws, so a wedge fails instead of hanging.
 */

const REAL_TIMER_BUDGET_MS = 5_000;
const POLL_MS = 10;

/** Wait on the real clock and resolve either way. waitFor throws on timeout; fake timers cannot drive this promise chain. */
async function settledWithin(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + REAL_TIMER_BUDGET_MS;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return predicate();
}

/**
 * Cold start: no host process, no credentials, empty directory.
 */
function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "https://authn.traycer.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function renderProvider(runnerHost: MockRunnerHost): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <RunnerHostContext.Provider value={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          fallback={<div data-testid="startup-fallback" />}
          // THE POINT OF THIS SUITE. `null` is what every production shell
          // passes; a factory here would skip the branch under test.
          messengerFactory={null}
          invalidator={null}
          requestId={null}
          remoteFetcher={null}
        >
          <div data-testid="startup-complete" />
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("HostRuntimeProvider startup (real messenger path)", () => {
  it("settles - publishes a binding and renders children", async () => {
    renderProvider(buildRunnerHost());

    const settled = await settledWithin(
      () => screen.queryByTestId("startup-complete") !== null,
    );

    // Stated as an explicit boolean rather than asserting on the DOM node so
    // the failure message names the real fault: startup did not finish inside
    // the budget, as opposed to some element being absent.
    expect(
      settled,
      `startup did not settle within ${String(REAL_TIMER_BUDGET_MS)}ms; the provider is still rendering its fallback`,
    ).toBe(true);
    expect(screen.queryByTestId("startup-fallback")).toBeNull();
  });

  it("renders the fallback until the binding is published", () => {
    renderProvider(buildRunnerHost());

    // Synchronous: startup is asynchronous by construction, so the very first
    // paint must be the fallback. If this ever passes trivially because
    // children mounted synchronously, the suite above stops proving anything.
    expect(screen.queryByTestId("startup-fallback")).not.toBeNull();
    expect(screen.queryByTestId("startup-complete")).toBeNull();
  });
});
