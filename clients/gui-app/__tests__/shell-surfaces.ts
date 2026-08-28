import type { IRunnerHost } from "@traycer-clients/shared/platform/runner-host";
import type { AnalyticsAppSurface } from "@/lib/analytics";
import type { DesktopPowerBridge } from "@/lib/windows/types";
import { createFakeRunnerHost } from "./create-fake-runner-host";

/**
 * The four shells that mount `<TraycerApp />`, as the two things a gate can
 * legitimately read: the CAPABILITIES their `IRunnerHost` declares, and the
 * PRODUCT flag their bootstrap sets.
 *
 * Kept in one place because the interesting property is a relationship
 * BETWEEN rows, and a suite that builds its own host inline can only assert
 * one row at a time. Two facts this table is meant to make unmissable:
 *
 * - `installedMobile`, `webapp` and `browserDev` have the SAME capability
 *   posture. Any gate that means "this shell cannot do X" must treat all
 *   three alike, and a gate keyed on `mobileApp` demonstrably does not.
 * - `webapp` and `browserDev` are capability-identical AND product-flag
 *   identical, which is why the analytics surface is declared rather than
 *   derived - nothing observable distinguishes them.
 */
export interface ShellSurfaceFixture {
  /** How a failing assertion names the shell. */
  readonly name: string;
  readonly runnerHost: IRunnerHost;
  /** What this shell's bootstrap passes to `setMobileApp`. */
  readonly mobileApp: boolean;
  /** What this shell's bootstrap passes to `setAnalyticsAppSurface`. */
  readonly analyticsSurface: AnalyticsAppSurface;
}

const desktopPowerBridge: DesktopPowerBridge = {
  setSleepBlocked: () => Promise.resolve(),
};

/**
 * `power` is a duck-typed extra a shell hangs on its host, not a typed
 * `IRunnerHost` field, so it is spread on rather than passed as an override -
 * the same shape `resolveDesktopPowerBridge` feature-detects at runtime.
 */
function createDesktopRunnerHost(): IRunnerHost {
  const host: IRunnerHost & { readonly power: DesktopPowerBridge } = {
    ...createFakeRunnerHost({ hasLocalHost: true }),
    power: desktopPowerBridge,
  };
  return host;
}

/**
 * No local host and no power bridge: every host it can reach is another
 * machine, and nothing on the other side of a `setSleepBlocked` call.
 */
function createRemoteOnlyRunnerHost(): IRunnerHost {
  return createFakeRunnerHost({
    hasLocalHost: false,
    workspaceFolders: {
      canPickNatively: false,
      pickFolders: () => Promise.resolve([]),
    },
  });
}

export function shellSurfaces(): readonly ShellSurfaceFixture[] {
  return [
    {
      name: "desktop",
      runnerHost: createDesktopRunnerHost(),
      mobileApp: false,
      analyticsSurface: "desktop",
    },
    {
      name: "installed mobile",
      runnerHost: createRemoteOnlyRunnerHost(),
      mobileApp: true,
      analyticsSurface: "mobile",
    },
    {
      name: "webapp",
      runnerHost: createRemoteOnlyRunnerHost(),
      mobileApp: false,
      analyticsSurface: "web",
    },
    {
      name: "browser dev",
      runnerHost: createRemoteOnlyRunnerHost(),
      mobileApp: false,
      analyticsSurface: "browser_dev",
    },
  ];
}
