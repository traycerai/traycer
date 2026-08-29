import type { ReactElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import { traycerInfo } from "@traycer-clients/shared/platform/traycer-info";
import { setMobileApp, setMobileAppPlatform } from "@/lib/mobile-app";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { ClientUpdateRequiredAction } from "@/components/host/client-update-required-action";
import type {
  DesktopAppUpdateCheckIntent,
  DesktopAppUpdateChannelChange,
  DesktopAppUpdateSnapshot,
  DesktopAppUpdatesBridge,
  DesktopCompatRecoveryPlan,
} from "@/lib/windows/types";
import type { ClientCompatibilityRequirement } from "@traycer/protocol/framework/index";

const mocks = vi.hoisted(() => ({
  toastFromRunnerError: vi.fn(),
}));

vi.mock("@/lib/runner-error-toast", () => ({
  toastFromRunnerError: mocks.toastFromRunnerError,
}));

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

afterEach(() => {
  cleanup();
  setMobileApp(false);
  setMobileAppPlatform(null);
});

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
 * The host's structured requirement.
 *
 * Current hosts always send `minimumKnownClientAppVersion` / `upgradeChannel`
 * as null and stamp `hostReleaseChannel` with their own line. Sufficiency is
 * compared as epochs, never as versions: `null` on the candidate is
 * insufficient, not a free pass.
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
    // oxlint-disable-next-line typescript/no-deprecated -- Required null placeholder retained for shipped-client wire compatibility.
    minimumKnownClientAppVersion: null,
    // oxlint-disable-next-line typescript/no-deprecated -- Required null placeholder retained for shipped-client wire compatibility.
    upgradeChannel: null,
    hostReleaseChannel: "stable",
    ...overrides,
  };
}

const IDLE_SNAPSHOT: DesktopAppUpdateSnapshot = {
  sequence: 0,
  status: "idle",
  currentVersion: "1.1.10",
  allowPrerelease: false,
  latestVersion: null,
  latestCompatibilityEpoch: null,
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
  // Annotated with the full change type. Inference from this default narrows
  // `outcome` to the literal `"changed"`, which then rejects a
  // `mockResolvedValue` for `refused-update-pending` - the macOS standing
  // refusal, which is exactly the case worth testing.
  readonly setAllowPrerelease = vi.fn(
    (): Promise<DesktopAppUpdateChannelChange> =>
      Promise.resolve({ outcome: "changed", snapshot: this.snapshot }),
  );
  // Annotated with the full plan type rather than inferred from this default.
  // Inference narrows `route` to the literal `"manual"`, which then rejects
  // every `mockResolvedValue` for the other three routes - the exact cases
  // these tests exist to cover.
  readonly resolveCompatRecovery = vi.fn(
    (): Promise<DesktopCompatRecoveryPlan> =>
      Promise.resolve({
        route: "manual",
        rcCandidateVersion: null,
        stagedVersion: null,
      }),
  );

  readonly getSnapshot = vi.fn((): Promise<DesktopAppUpdateSnapshot> =>
    Promise.resolve(this.snapshot),
  );

  private readonly handlers = new Set<
    (snapshot: DesktopAppUpdateSnapshot) => void
  >();

  constructor(public snapshot: DesktopAppUpdateSnapshot) {}

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
    this.handlers.add(handler);
    queueMicrotask(() => handler(this.snapshot));
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  /** A later push from main - the update check landing after mount. */
  push(next: DesktopAppUpdateSnapshot): void {
    this.snapshot = next;
    for (const handler of this.handlers) handler(next);
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
      <ClientUpdateRequiredAction requirement={requirement({})} />,
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
      <ClientUpdateRequiredAction requirement={requirement({})} />,
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
        <ClientUpdateRequiredAction requirement={requirement({})} />,
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
      <ClientUpdateRequiredAction requirement={requirement({})} />,
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
      <ClientUpdateRequiredAction requirement={requirement({})} />,
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
          requirement={requirement({ hostReleaseChannel: channel })}
        />,
        null,
      );
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    }
  });

  it("prefers the updater when it has a build whose epoch clears the floor", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status: "available",
      allowPrerelease: true,
      latestVersion: "1.2.0-rc.2",
      latestCompatibilityEpoch: 2,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({
          hostReleaseChannel: "rc",
          minimumCompatibilityEpoch: 2,
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
   * Compared as epochs, never as versions. A `1.9.0` hotfix branched off a
   * pre-epoch line is newer by every SemVer comparison and still does not
   * clear a floor of 2 - Fable's channel-scoped invariant in test form: a
   * stable `desktop-v*` below an RC-only floor is still the RC resolver's
   * newest candidate, and only its own `compatibilityEpoch` refuses it.
   *
   * `null` IS INSUFFICIENT. The predecessor read `minimumKnownClientAppVersion
   * === null` as "the host named no minimum, so anything satisfies it" - a
   * catastrophic reading now that epoch-only policy leaves that field
   * permanently null. Here `null` means the candidate's generation could not
   * be established.
   */
  function bridgeWith(
    status: "available" | "ready" | "downloading",
    latestCompatibilityEpoch: number | null,
    latestVersion: string | null,
  ): FakeAppUpdatesBridge {
    return new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      status,
      latestVersion,
      latestCompatibilityEpoch,
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
  }

  it("a null epoch on a READY snapshot must not render the install affordance", async () => {
    // THE INVERTED ARM, asserted directly rather than via a recovery route:
    // `status: "ready"` used to be enough to offer "Restart to update".
    const bridge = bridgeWith("ready", null, "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.getSnapshot).toHaveBeenCalled();
    });
    await flushMicrotasks();
    expect(screen.queryByTestId("client-update-required-install")).toBeNull();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["equal to the floor", 2],
    ["higher than the floor", 3],
  ])("OFFERS a cached update whose epoch is %s", async (_label, epoch) => {
    const bridge = bridgeWith("available", epoch, "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download"),
      ).toBeTruthy();
    });
  });

  it("REFUSES a cached update whose epoch is below the floor", async () => {
    const bridge = bridgeWith("available", 1, "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("client-update-required-download")).toBeNull();
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("never lets a higher SemVer decide: lower epoch is still insufficient", async () => {
    const bridge = bridgeWith("available", 1, "1.9.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-download-page"),
      ).toBeTruthy();
    });
    expect(screen.queryByTestId("client-update-required-download")).toBeNull();
  });

  it("REFUSES to offer a stale READY build - the restart would change nothing", async () => {
    const bridge = bridgeWith("ready", 1, "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
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
    const bridge = bridgeWith("downloading", 1, "1.2.0");
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
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
      latestCompatibilityEpoch: 1,
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
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
      latestCompatibilityEpoch: 2,
      allowPrerelease: true,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ minimumCompatibilityEpoch: 2 })}
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
        latestCompatibilityEpoch: 1,
        allowPrerelease: true,
        lastCheckedAt: "2026-06-15T00:00:00.000Z",
      });
      renderAction(
        <ClientUpdateRequiredAction
          requirement={requirement({ minimumCompatibilityEpoch: 2 })}
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

describe("<ClientUpdateRequiredAction /> hostReleaseChannel routing", () => {
  /**
   * Interpreted HERE, once, and passed to main as a verdict. Assert on the
   * argument the bridge received so there is never a second place that could
   * decide an unrecognized channel means RC.
   */
  function idleBridge(): FakeAppUpdatesBridge {
    return new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
  }

  it("passes hostAllowsRcRecovery: true only for the exact string rc", async () => {
    const bridge = idleBridge();
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ hostReleaseChannel: "rc" })}
      />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.resolveCompatRecovery).toHaveBeenCalledWith({
        minimumEpoch: 2,
        hostAllowsRcRecovery: true,
      });
    });
  });

  it.each([
    ["stable", "stable"],
    ["dev", "dev"],
    ["absent", undefined],
    ["an unknown line", "canary"],
  ] as const)(
    "passes hostAllowsRcRecovery: false for %s",
    async (_label, hostReleaseChannel) => {
      const bridge = idleBridge();
      renderAction(
        <ClientUpdateRequiredAction
          requirement={requirement({ hostReleaseChannel })}
        />,
        bridge,
      );
      await waitFor(() => {
        expect(bridge.resolveCompatRecovery).toHaveBeenCalledWith({
          minimumEpoch: 2,
          hostAllowsRcRecovery: false,
        });
      });
    },
  );
});

describe("<ClientUpdateRequiredAction /> enable-rc arm", () => {
  it("names the probe's version and calls setAllowPrerelease(true)", async () => {
    const snapshot: DesktopAppUpdateSnapshot = {
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    };
    const bridge = new FakeAppUpdatesBridge(snapshot);
    bridge.resolveCompatRecovery.mockResolvedValue({
      route: "enable-rc",
      rcCandidateVersion: "1.2.0-rc.4",
      stagedVersion: null,
    });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ hostReleaseChannel: "rc" })}
      />,
      bridge,
    );
    // Role query, not a test id: this is an interactive control, and its
    // ACCESSIBLE NAME is the thing the user reads before consenting to a
    // channel change. Asserting on the name is what pins that the build is
    // actually named in the offer.
    const rcButton = await screen.findByRole("button", {
      name: /Enable RC updates and get 1\.2\.0-rc\.4/u,
    });
    fireEvent.click(rcButton);
    await waitFor(() => {
      expect(bridge.setAllowPrerelease).toHaveBeenCalledWith(true);
    });
  });

  it("reports a failed RC channel change", async () => {
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    bridge.resolveCompatRecovery.mockResolvedValue({
      route: "enable-rc",
      rcCandidateVersion: "1.2.0-rc.4",
      stagedVersion: null,
    });
    const error = new Error("preference write failed");
    bridge.setAllowPrerelease.mockRejectedValue(error);
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ hostReleaseChannel: "rc" })}
      />,
      bridge,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Enable RC updates and get 1\.2\.0-rc\.4/u,
      }),
    );
    await waitFor(() => {
      expect(mocks.toastFromRunnerError).toHaveBeenCalledWith(
        error,
        "Couldn't enable RC updates",
      );
    });
  });

  it("re-resolves the plan when a check lands an insufficient candidate after mount", async () => {
    // THE SIDE-EFFECT REGRESSION, not a caching nicety. The plan is cached at
    // `staleTime: Infinity`, and resolving one is what discards an insufficient
    // staged artifact, disarms quit-time install, and produces the macOS
    // staged-update warning.
    //
    // Opening sequence: the dialog mounts while the mount-triggered check is
    // still in flight, so the first plan resolves against NOTHING held. The
    // check then lands an INSUFFICIENT candidate. `candidateSufficient` is
    // still false and `allowPrerelease` has not moved - so without the held
    // candidate's status in the key, main is never asked again and every one of
    // those side effects is silently skipped.
    const bridge = new FakeAppUpdatesBridge({
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    });
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      bridge,
    );
    await waitFor(() => {
      expect(bridge.resolveCompatRecovery).toHaveBeenCalledTimes(1);
    });

    bridge.push({
      ...IDLE_SNAPSHOT,
      sequence: 2,
      status: "available",
      latestVersion: "1.2.0",
      latestCompatibilityEpoch: 1,
      lastCheckedAt: "2026-06-15T00:00:01.000Z",
      lastCheckIntent: "automatic",
    });

    await waitFor(() => {
      expect(bridge.resolveCompatRecovery).toHaveBeenCalledTimes(2);
    });
  });

  it("a refused opt-in invalidates the plan and re-resolves to the honest next step", async () => {
    // Main can answer refused-update-pending if a download started between
    // the probe and the click, or (macOS) an artifact reached native staging
    // in that window. Asking again is the correct response; reporting a
    // failure is not.
    const snapshot: DesktopAppUpdateSnapshot = {
      ...IDLE_SNAPSHOT,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    };
    const bridge = new FakeAppUpdatesBridge(snapshot);
    bridge.setAllowPrerelease.mockResolvedValue({
      outcome: "refused-update-pending",
      snapshot,
    });
    bridge.resolveCompatRecovery
      .mockResolvedValueOnce({
        route: "enable-rc",
        rcCandidateVersion: "1.2.0-rc.4",
        stagedVersion: null,
      })
      .mockResolvedValueOnce({
        route: "restart-to-clear-staged",
        rcCandidateVersion: null,
        stagedVersion: "1.1.11",
      });
    renderAction(
      <ClientUpdateRequiredAction
        requirement={requirement({ hostReleaseChannel: "rc" })}
      />,
      bridge,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Enable RC updates/u }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-staged-note"),
      ).toBeTruthy();
    });
    expect(bridge.resolveCompatRecovery).toHaveBeenCalledTimes(2);
  });
});

describe("<ClientUpdateRequiredAction /> restart-to-clear-staged arm", () => {
  it("states the staged fact, keeps the manual link, and offers no install", async () => {
    const snapshot: DesktopAppUpdateSnapshot = {
      ...IDLE_SNAPSHOT,
      status: "ready",
      latestVersion: "1.1.11",
      latestCompatibilityEpoch: 1,
      lastCheckedAt: "2026-06-15T00:00:00.000Z",
      lastCheckIntent: "automatic",
    };
    const bridge = new FakeAppUpdatesBridge(snapshot);
    bridge.resolveCompatRecovery.mockResolvedValue({
      route: "restart-to-clear-staged",
      rcCandidateVersion: null,
      stagedVersion: "1.1.11",
    });
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      bridge,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("client-update-required-staged-note"),
      ).toBeTruthy();
    });
    expect(
      screen.getByTestId("client-update-required-download-page"),
    ).toBeTruthy();
    expect(screen.queryByTestId("client-update-required-install")).toBeNull();
    expect(screen.queryByTestId("client-update-required-enable-rc")).toBeNull();
  });
});

describe("<ClientUpdateRequiredAction /> mobile shell", () => {
  it("names the iOS stores instead of the releases page button", () => {
    // No desktop arm above applies without an updater bridge, so a mobile
    // build always falls through to here - and the releases page is a
    // desktop remedy a phone cannot act on. The copy must name the shell's
    // own update channel, not a generic "update" a tester cannot locate.
    setMobileApp(true);
    setMobileAppPlatform("ios");
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      null,
    );
    const note = screen.getByTestId("client-update-required-mobile-note");
    expect(note.textContent).toContain("TestFlight");
    expect(note.textContent).toContain("App Store");
    expect(note.textContent).not.toContain("Google Play");
    expect(
      screen.queryByTestId("client-update-required-download-page"),
    ).toBeNull();
  });

  it("names Google Play on Android", () => {
    setMobileApp(true);
    setMobileAppPlatform("android");
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      null,
    );
    const note = screen.getByTestId("client-update-required-mobile-note");
    expect(note.textContent).toContain("Google Play");
    expect(note.textContent).not.toContain("TestFlight");
  });

  it("stays store-neutral when the shell reports no platform", () => {
    // The mobile stream's dev browser tab: installed-app policy without a
    // native shell. Naming either store would be a guess.
    setMobileApp(true);
    renderAction(
      <ClientUpdateRequiredAction requirement={requirement({})} />,
      null,
    );
    const note = screen.getByTestId("client-update-required-mobile-note");
    expect(note.textContent).toContain("store you installed it from");
    expect(note.textContent).not.toContain("TestFlight");
    expect(note.textContent).not.toContain("Google Play");
  });
});
