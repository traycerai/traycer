import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { HostRuntimeProvider, hostRpcRegistry } from "@/lib/host";
import { RunnerHostContext } from "@/providers/runner-host-context";

/**
 * `HostRuntimeProvider` driven through its REAL startup path.
 *
 * Every other harness in this package hands the provider a `messengerFactory`,
 * which is exactly the branch production does not take: desktop passes `null`
 * so the runtime builds its own messenger from the selected host's endpoint.
 * The whole `auth.start()` -> `directory.start()` -> `runtime.start()` ->
 * bridge-mount sequence therefore had no coverage at all, and the way it had
 * none is the point - a provider that never settles renders `fallback`
 * forever, and a suite waiting on it HANGS. A hang is not a failure, so no
 * census reports it and no `--testTimeout` interrupts it usefully.
 *
 * So the wait here is bounded by a real timer that RESOLVES rather than
 * throws, and the assertion is made on what it found. A future regression that
 * wedges startup fails this suite with "startup never settled" plus the phase
 * it reached, instead of stalling the run.
 */

const REAL_TIMER_BUDGET_MS = 5_000;
const POLL_MS = 10;

/**
 * Waits for `predicate` under a REAL timer, and resolves either way.
 *
 * Deliberately not `waitFor`: Testing Library's version throws on timeout,
 * which reads as a normal assertion failure and hides the distinction this
 * suite exists to draw - "settled into the wrong state" versus "never settled
 * at all". Also deliberately not fake timers: the thing under test is a chain
 * of real promises through services this suite does not drive, so the clock
 * has to be the real one.
 */
async function settledWithin(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + REAL_TIMER_BUDGET_MS;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return predicate();
}

/**
 * A shell that owns no host process and no stored credentials - the ordinary
 * cold start, and the cheapest one to reason about. `hosts: []` keeps the
 * directory empty so nothing here depends on a fixture host's shape.
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
