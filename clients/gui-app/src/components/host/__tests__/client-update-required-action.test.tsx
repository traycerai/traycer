import type { ReactElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ClientUpdateRequiredAction } from "@/components/host/client-update-required-action";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
} from "@/lib/windows/types";

/**
 * The remedy on the blocking "Update Traycer to continue" surface.
 *
 * THE PROPERTY UNDER TEST IS "NEVER A DEAD END". This action is the only thing
 * a user can act on once a host has refused their client at its epoch gate:
 * Update host cannot help (the host is the newer leg by construction), Retry
 * reaches the same verdict, and there is nothing to reset. So every arm has to
 * lead somewhere that can produce a newer build.
 *
 * The awkward arm is `idle`. The desktop DOES auto-check at launch
 * (`installAutoUpdater` -> `checkForUpdatesNow(…, "automatic")`), but that
 * check is gated on `canCheckForUpdates` and happens exactly once, while this
 * surface is reachable hours later - a host can activate a floor, or the user
 * can point at a different host, long after launch. Sending someone to
 * download by hand while their own updater could have delivered the build is
 * the gap these specs close, and re-asking an updater that already answered is
 * the loop they refuse to open.
 */

afterEach(cleanup);

/**
 * Lets every already-queued microtask settle.
 *
 * The negative specs below assert something did NOT happen, which is only
 * meaningful once the read that would have triggered it has resolved - a bare
 * `await Promise.resolve()` returns before the bridge's own promise chain runs
 * and would pass against a genuinely broken hook.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const IDLE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "1.1.10",
  allowPrerelease: false,
  latestVersion: null,
  downloadProgress: null,
  installBlockedReason: null,
  installGuidance: null,
  installInFlight: false,
  errorMessage: null,
  lastCheckedAt: null,
  lastCheckIntent: null,
};

class FakeAppUpdatesBridge implements DesktopAppUpdatesBridge {
  readonly checkForUpdates = vi.fn(
    (_intent: DesktopAppUpdateCheckIntent): Promise<DesktopAppUpdateSnapshot> =>
      Promise.resolve(this.snapshot),
  );
  readonly downloadUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  readonly installUpdate = vi.fn(() => Promise.resolve(this.snapshot));
  readonly setAllowPrerelease = vi.fn(() => Promise.resolve(this.snapshot));

  readonly getSnapshot = vi.fn((): Promise<DesktopAppUpdateSnapshot> =>
    Promise.resolve(this.snapshot),
  );

  constructor(readonly snapshot: DesktopAppUpdateSnapshot) {}

  /**
   * Delivers the snapshot to the store immediately on subscribe.
   *
   * The real bridge pushes from the main process; without this the store would
   * only ever hold what its async `getSnapshot()` prime returned, and a spec
   * asserting on RENDERED state would be racing that promise.
   */
  onChange(handler: (snapshot: DesktopAppUpdateSnapshot) => void): {
    dispose(): void;
  } {
    queueMicrotask(() => handler(this.snapshot));
    return { dispose: () => undefined };
  }
}

function makeHost(appUpdates: DesktopAppUpdatesBridge | null): IRunnerHost {
  const host = new MockRunnerHost({
    signInUrl: "https://example.invalid/signin",
    authnBaseUrl: "https://example.invalid",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
  if (appUpdates === null) return host;
  const proto = Object.getPrototypeOf(host) as object;
  return Object.assign(Object.create(proto) as IRunnerHost, host, {
    appUpdates,
  });
}

function renderAction(
  ui: ReactElement,
  appUpdates: DesktopAppUpdatesBridge | null,
): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RunnerHostProvider runnerHost={makeHost(appUpdates)}>
        {ui}
      </RunnerHostProvider>
    </QueryClientProvider>,
  );
}

describe("<ClientUpdateRequiredAction /> update check on mount", () => {
  it("asks the updater once when it has never been asked", async () => {
    const bridge = new FakeAppUpdatesBridge(IDLE_SNAPSHOT);
    renderAction(
      <ClientUpdateRequiredAction upgradeChannel="stable" />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);
    });
    expect(bridge.checkForUpdates).toHaveBeenCalledWith("automatic");
  });

  it("does NOT re-ask an updater that already answered", async () => {
    // `lastCheckedAt` set means the launch check ran. "up-to-date" and "error"
    // are real answers; re-asking them on every mount would turn a blocking
    // dialog into a poller.
    //
    // Note this asserts against the BRIDGE's snapshot, not the rendered one:
    // `useDesktopAppUpdates` primes asynchronously, so at first render the
    // rendered snapshot is still the module default (idle / never checked).
    // A hook that decided from THAT would call here, which is the bug this
    // spec is written to catch.
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction upgradeChannel="stable" />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.getSnapshot).toHaveBeenCalled();
    });
    await flushMicrotasks();
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
  });

  it("does NOT ask while a check or a download is already in flight", async () => {
    for (const status of ["checking", "downloading", "available"] as const) {
      cleanup();
      const bridge = new FakeAppUpdatesBridge({ ...IDLE_SNAPSHOT, status });
      renderAction(
        <ClientUpdateRequiredAction upgradeChannel="stable" />,
        bridge,
      );
      await waitFor(() => {
        expect(bridge.getSnapshot).toHaveBeenCalled();
      });
      await flushMicrotasks();
      expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    }
  });

  it("shows a pending state for a MANUAL check in flight, not the manual link", async () => {
    // The reachable case is a check started from the header while this dialog
    // is open. It is NOT the check this surface starts: `checkForUpdatesNow`
    // publishes `status: "checking"` only for `intent === "manual"`, so the
    // self-started automatic one leaves the snapshot `idle` and the manual
    // link stays up for its duration. Rendering "Get the latest Traycer" under
    // a running check would tell someone to download by hand a second before
    // their own updater answers.
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "checking",
    });
    renderAction(
      <ClientUpdateRequiredAction upgradeChannel="stable" />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-checking"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByTestId("client-update-required-download-page"),
    ).toBeNull();
  });

  it("never asks when there is no updater bridge at all", async () => {
    // Web/dev shells. The manual link is the whole answer there.
    renderAction(<ClientUpdateRequiredAction upgradeChannel="stable" />, null);
    await Promise.resolve();
    expect(
      screen.getByTestId("client-update-required-download-page"),
    ).toBeTruthy();
  });
});

describe("<ClientUpdateRequiredAction /> manual fallback", () => {
  it("points BOTH channels at the releases page", () => {
    // The stable arm used to point at an unverified marketing URL that exists
    // nowhere else in either repository - a dead link in the one place a user
    // has no other route. GitHub Releases lists prereleases alongside stable,
    // so one first-party destination serves both.
    expect(traycerInfo.releasesPage).toBe(
      "https://github.com/traycerai/traycer/releases",
    );
    for (const channel of ["stable", "rc"] as const) {
      cleanup();
      renderAction(
        <ClientUpdateRequiredAction upgradeChannel={channel} />,
        null,
      );
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    }
  });

  it("routes an rc remedy straight to the link when this install follows stable", async () => {
    // Channel mismatch: the updater will report "up to date" forever while the
    // host keeps refusing, so offering a Download button that cannot find the
    // build is the most confusing state this surface can produce.
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "available",
      allowPrerelease: false,
      latestVersion: "1.1.11",
    });
    renderAction(<ClientUpdateRequiredAction upgradeChannel="rc" />, bridge);
    await waitFor(() => {
      expect(bridge.getSnapshot).toHaveBeenCalled();
    });
    expect(
      screen.getByTestId("client-update-required-download-page"),
    ).toBeTruthy();
    expect(screen.queryByTestId("client-update-required-download")).toBeNull();
  });

  it("prefers the updater when it has a build to offer", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "available",
      allowPrerelease: true,
      latestVersion: "1.2.0-rc.2",
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
    });
    renderAction(<ClientUpdateRequiredAction upgradeChannel="rc" />, bridge);
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByTestId("client-update-required-download-page"),
    ).toBeNull();
  });
});
