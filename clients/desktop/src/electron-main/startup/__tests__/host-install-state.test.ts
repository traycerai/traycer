import { describe, expect, it, vi } from "vitest";
import type { HostControllerStatus } from "../../host/host-controller-types";

const electronMock = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    getName: vi.fn(() => "Traycer"),
    getVersion: vi.fn(() => "0.0.0"),
    on: vi.fn(),
  },
}));
vi.mock("electron", () => electronMock);

const { readHostInstalledForBootstrap, bootstrapHostWithInstallState } =
  await import("../host-install-state");

function statusWith(installedVersion: string | null): HostControllerStatus {
  return {
    download: null,
    mutation: null,
    installedVersion,
    latestVersion: null,
    stagedVersion: null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady: false,
    activation: "unavailable",
    reachable: false,
    localAttempt: null,
    removedByUser: false,
    checkedAt: "2026-08-05T00:00:00.000Z",
  };
}

describe("readHostInstalledForBootstrap", () => {
  it("reports false when no install record exists, so bootstrap can skip the wait", async () => {
    const getStatus = vi.fn(() => Promise.resolve(statusWith(null)));
    await expect(readHostInstalledForBootstrap({ getStatus })).resolves.toBe(
      false,
    );
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("reports true for an installed host, whose slow start must still be waited out", async () => {
    // `activation: "unavailable"` in both fixtures on purpose: it describes the
    // RUNNING runtime and so cannot tell these two machines apart. Only the
    // install record can, which is the whole reason this helper exists.
    const getStatus = vi.fn(() => Promise.resolve(statusWith("1.1.9")));
    await expect(readHostInstalledForBootstrap({ getStatus })).resolves.toBe(
      true,
    );
  });

  it("falls back to true when the status read rejects", async () => {
    // The safer of the two wrong answers: `true` preserves the historical
    // wait, so an unreadable install record cannot silently strip a legitimate
    // readiness wait - and its HOST_NOT_READY signal - from a host that is
    // installed and merely slow. Being wrong this way costs a slow launch;
    // being wrong the other way loses a real failure report.
    const getStatus = vi.fn(() => Promise.reject(new Error("EACCES")));
    await expect(readHostInstalledForBootstrap({ getStatus })).resolves.toBe(
      true,
    );
  });
});

// The boot seam itself. `runDeferredBackground` is replaced wholesale by the
// startup test hooks, so without these the wiring is the one part nothing
// covers: hard-coding `hostInstalled: true` at the seam, or dropping the
// status read, would restore the full 60s regression with every other test
// still green.
describe("bootstrapHostWithInstallState", () => {
  it("bootstraps with hostInstalled false when nothing is installed", async () => {
    const bootstrap = vi.fn(() => Promise.resolve());
    await bootstrapHostWithInstallState(
      { bootstrap },
      { getStatus: () => Promise.resolve(statusWith(null)) },
    );
    expect(bootstrap).toHaveBeenCalledWith({ hostInstalled: false });
  });

  it("bootstraps with hostInstalled true for an installed host", async () => {
    const bootstrap = vi.fn(() => Promise.resolve());
    await bootstrapHostWithInstallState(
      { bootstrap },
      { getStatus: () => Promise.resolve(statusWith("1.1.9")) },
    );
    expect(bootstrap).toHaveBeenCalledWith({ hostInstalled: true });
  });

  it("still bootstraps - and keeps the wait - when the status read rejects", async () => {
    // The failure that matters most: `timed()` swallows a rejection from this
    // step, so a status error escaping instead of being absorbed would skip
    // bootstrap entirely and leave no pid-metadata watcher installed.
    const bootstrap = vi.fn(() => Promise.resolve());
    await bootstrapHostWithInstallState(
      { bootstrap },
      { getStatus: () => Promise.reject(new Error("EACCES")) },
    );
    expect(bootstrap).toHaveBeenCalledWith({ hostInstalled: true });
  });
});
