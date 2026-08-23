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
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";

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

/**
 * The host's structured requirement. `minimumKnownClientAppVersion` is the one
 * the version-sufficiency specs below vary: it is what a cached update has to
 * clear before this surface will offer it.
 */
function requirement(
  overrides: Partial<ClientCompatibilityRequirement>,
): ClientCompatibilityRequirement {
  return {
    minimumCompatibilityEpoch: 2,
    observedCompatibilityEpoch: 1,
    failure: "below-minimum",
    observedClientKind: "desktop",
    observedClientAppVersion: "1.1.10",
    observedClientAppVersionStatus: "valid",
    minimumKnownClientAppVersion: "1.2.0",
    upgradeChannel: "stable",
    ...overrides,
  };
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

/**
 * Attaches the bridge to the CONSTRUCTED host, rather than cloning it.
 *
 * A `Object.create(proto) + Object.assign` clone copies field VALUES but not
 * the closures the constructor built over `this`. `MockRunnerHost` builds an
 * in-process selection authority in its constructor whose `ensureReady`
 * callback captures the original instance, so a clone shares one authority
 * that reads and mutates a DIFFERENT object's local-host state. Nothing in
 * this file drives that authority today, which is exactly why it is worth
 * removing now: the next spec added here would inherit a helper that hands
 * back a half-wired host and no failure that points at the helper.
 *
 * `appUpdates` is not on `IRunnerHost` - `resolveDesktopAppUpdatesBridge`
 * reads it with `Reflect.get` - so assigning it onto the instance is how the
 * capability is expressed, and `Object.assign` returns an intersection that is
 * already assignable to `IRunnerHost` (no cast needed).
 */
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
  return Object.assign(host, { appUpdates });
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
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: null })}
      />,
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
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: null })}
      />,
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
        <ClientUpdateRequiredAction
          requirement={requirement({ minimumKnownClientAppVersion: null })}
        />,
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
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: null })}
      />,
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
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ upgradeChannel: "stable" })}
      />,
      null,
    );
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
        <ClientUpdateRequiredAction
          requirement={requirement({ upgradeChannel: channel })}
        />,
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
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ upgradeChannel: "rc" })}
      />,
      bridge,
    );
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
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({
          upgradeChannel: "rc",
          // The build the cache is holding IS the one the host asks for, so
          // this spec stays about updater-vs-link preference rather than
          // about version sufficiency (covered in its own describe below).
          minimumKnownClientAppVersion: "1.2.0-rc.2",
        })}
      />,
      bridge,
    );
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

describe("<ClientUpdateRequiredAction /> cached-update sufficiency", () => {
  /**
   * THE CACHED UPDATE IS NOT AUTOMATICALLY THE REMEDY.
   *
   * The updater's snapshot is a cache: it can hold an `available` /
   * `downloading` / `ready` build found at launch while the host raised its
   * floor afterwards. Offering that build produces a restart into the SAME
   * rejection - an update loop that never converges, behind a button that
   * looks like the fix.
   *
   * Compared with the shared strict-SemVer comparator rather than by string,
   * because prerelease ordering decides two of these cases and a lexical
   * compare gets both backwards.
   */
  function bridgeWith(
    status: "available" | "ready" | "downloading",
    latestVersion: string | null,
  ): FakeAppUpdatesBridge {
    return new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status,
      latestVersion,
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
  }

  it.each([
    ["greater", "1.3.0", "1.2.0"],
    ["equal", "1.2.0", "1.2.0"],
    ["a release over the required prerelease", "1.2.0", "1.2.0-rc.2"],
    ["a later prerelease", "1.2.0-rc.3", "1.2.0-rc.2"],
  ])(
    "OFFERS a cached update that is %s (%s >= %s)",
    async (_label, latestVersion, required) => {
      const bridge = bridgeWith("available", latestVersion);
      renderAction(
        <ClientUpdateRequiredAction
          requirement={requirement({ minimumKnownClientAppVersion: required })}
        />,
        bridge,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId("client-update-required-download"),
        ).toBeTruthy();
      });
    },
  );

  it.each([
    ["older", "1.2.0", "1.3.0"],
    ["a prerelease of the required release", "1.2.0-rc.2", "1.2.0"],
    ["an earlier prerelease", "1.2.0-rc.1", "1.2.0-rc.2"],
    ["unparseable", "not-a-version", "1.2.0"],
  ])(
    "REFUSES a cached update that is %s (%s < %s) and shows the releases page",
    async (_label, latestVersion, required) => {
      const bridge = bridgeWith("available", latestVersion);
      renderAction(
        <ClientUpdateRequiredAction
          requirement={requirement({ minimumKnownClientAppVersion: required })}
        />,
        bridge,
      );
      await waitFor(() => {
        expect(
          screen.getByTestId("client-update-required-download-page"),
        ).toBeTruthy();
      });
      expect(
        screen.queryByTestId("client-update-required-download"),
      ).toBeNull();
      // And it must not have been downloaded on our behalf either.
      expect(bridge.downloadUpdate).not.toHaveBeenCalled();
    },
  );

  it("REFUSES to offer a stale READY build - the restart would change nothing", async () => {
    // The worst arm: `ready` means the insufficient build is already
    // downloaded, so "Restart to update" is one click from a restart into the
    // same rejection.
    const bridge = bridgeWith("ready", "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("client-update-required-install")).toBeNull();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("REFUSES to show progress for a stale DOWNLOADING build", async () => {
    const bridge = bridgeWith("downloading", "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    });
    expect(
      screen.queryByTestId("client-update-required-downloading"),
    ).toBeNull();
  });

  it("OFFERS the cached update when the host named no minimum build", async () => {
    // Nothing to compare against. Refusing here would strand the user with no
    // updater path at all over a fact the host declined to state, and the
    // host's own reason already degrades to "install the latest version".
    const bridge = bridgeWith("available", "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: null })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download"),
      ).toBeTruthy();
    });
  });

  it("REFUSES a cached update the updater cannot name", async () => {
    // `latestVersion: null` with an `available` status - nothing proves the
    // build helps, and an install that changes nothing costs a restart.
    const bridge = bridgeWith("available", null);
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    });
  });
});

describe("<ClientUpdateRequiredAction /> does not re-ask an updater holding a build", () => {
  /**
   * A cached build - stale or not - is a state this surface CANNOT ask past.
   *
   * `checkForUpdatesNow` returns the current snapshot before any feed query
   * while the status is `available` / `ready` / `downloading`, for every
   * intent, so a request here would be a no-op IPC and a test asserting it
   * would only prove the bridge recorded the call. These specs pin the
   * restraint instead: the render gate sends the user to the releases page,
   * and nothing pretends the updater could have been coaxed into helping.
   */
  it("does NOT ask when the updater is holding an INSUFFICIENT build either", async () => {
    // The tempting case, and the one that must stay restrained: the cached
    // 1.2.0 cannot clear a floor of 1.3.0, so it looks like a re-check is one
    // request from the answer. Main would return this same snapshot without
    // touching the feed, so the request buys nothing - the releases link the
    // render gate falls through to IS the recovery.
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "available",
      latestVersion: "1.2.0",
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.getSnapshot).toHaveBeenCalled();
    });
    await flushMicrotasks();
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    // ...and the user still has a way out.
    expect(
      screen.getByTestId("client-update-required-download-page"),
    ).toBeTruthy();
  });

  it("does NOT ask when the updater is holding a SUFFICIENT build", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "available",
      latestVersion: "1.3.0",
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.getSnapshot).toHaveBeenCalled();
    });
    await flushMicrotasks();
    expect(bridge.checkForUpdates).not.toHaveBeenCalled();
  });

  // The status literals need the explicit tuple type: inferred from the rows
  // alone they widen to `string`, which `DesktopAppUpdateSnapshot` refuses.
  it.each<[string, DesktopAppUpdateSnapshot["status"], boolean]>([
    ["mid-download", "downloading", false],
    ["mid-install", "ready", true],
  ])(
    "does NOT ask %s, however stale the build",
    async (_label, status, installInFlight) => {
      const bridge = new FakeAppUpdatesBridge({
        ...IDLE_SNAPSHOT,
        status,
        installInFlight,
        latestVersion: "1.2.0",
        allowPrerelease: true,
        lastCheckedAt: "2026-06-15T00:00:00.000Z",
      });
      renderAction(
        <ClientUpdateRequiredAction
          requirement={requirement({ minimumKnownClientAppVersion: "1.3.0" })}
        />,
        bridge,
      );
      await waitFor(() => {
        expect(bridge.getSnapshot).toHaveBeenCalled();
      });
      await flushMicrotasks();
      expect(bridge.checkForUpdates).not.toHaveBeenCalled();
    },
  );
});
