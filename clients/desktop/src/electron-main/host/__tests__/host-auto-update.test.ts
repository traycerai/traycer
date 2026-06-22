import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  HostAutoUpdateDeps,
  HostAutoUpdateOutcome,
} from "../host-auto-update";

// `reconcileHostAutoUpdate` is the idle-gated host updater shared by the
// launch boot phase and the quit-to-install hook. Behaviour pinned here:
//
//   - No update available / unreachable -> "up-to-date", never runs the update.
//   - Host busy -> "skipped-busy", never runs the update (protects in-progress
//     work).
//   - Host not running (no websocket url) -> idle, runs the update.
//   - Update fails -> "failed", does NOT refresh the post-update cache.
//   - Success -> "updated", runs the update then force-refreshes the cache.

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), isPackaged: false },
}));

vi.mock("electron-log", () => {
  const fns = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    default: { transports: { file: {} }, ...fns },
    transports: { file: {} },
    ...fns,
  };
});

function makeDeps(
  overrides: Partial<HostAutoUpdateDeps> & {
    readonly updateAvailable?: boolean;
    readonly reachable?: boolean;
    readonly latestVersion?: string | null;
    readonly websocketUrl?: string | null;
    readonly busy?: boolean;
  },
): {
  readonly deps: HostAutoUpdateDeps;
  readonly runHostUpdate: Mock;
  readonly refreshAfter: Mock;
  readonly probeBusy: Mock;
} {
  const runHostUpdate = vi.fn().mockResolvedValue(undefined);
  const refreshAfter = vi.fn().mockResolvedValue(undefined);
  const probeBusy = vi.fn().mockResolvedValue(overrides.busy ?? false);
  const deps: HostAutoUpdateDeps = {
    awaitHostReady: vi.fn().mockResolvedValue(undefined),
    checkUpdateState: vi.fn().mockResolvedValue({
      checkedAt: "2026-06-23T00:00:00Z",
      latestVersion:
        overrides.latestVersion === undefined
          ? "0.0.3"
          : overrides.latestVersion,
      installedVersion: "0.0.2",
      updateAvailable: overrides.updateAvailable ?? true,
      reachable: overrides.reachable ?? true,
      errorMessage: null,
    }),
    getHostWebsocketUrl: vi.fn(
      () =>
        (overrides.websocketUrl === undefined
          ? "ws://127.0.0.1:5000/rpc"
          : overrides.websocketUrl) as string | null,
    ),
    probeBusy,
    runHostUpdate,
    refreshAfter,
    ...overrides,
  };
  return { deps, runHostUpdate, refreshAfter, probeBusy };
}

async function run(deps: HostAutoUpdateDeps): Promise<HostAutoUpdateOutcome> {
  const { reconcileHostAutoUpdate } = await import("../host-auto-update");
  return reconcileHostAutoUpdate("test", deps);
}

describe("reconcileHostAutoUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no update is available", async () => {
    const { deps, runHostUpdate } = makeDeps({ updateAvailable: false });
    expect(await run(deps)).toBe("up-to-date");
    expect(runHostUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when the registry is unreachable", async () => {
    const { deps, runHostUpdate } = makeDeps({ reachable: false });
    expect(await run(deps)).toBe("up-to-date");
    expect(runHostUpdate).not.toHaveBeenCalled();
  });

  it("defers when the host is busy and never tears down work", async () => {
    const { deps, runHostUpdate, refreshAfter } = makeDeps({ busy: true });
    expect(await run(deps)).toBe("skipped-busy");
    expect(runHostUpdate).not.toHaveBeenCalled();
    expect(refreshAfter).not.toHaveBeenCalled();
  });

  it("updates an idle host and force-refreshes the cache after", async () => {
    const { deps, runHostUpdate, refreshAfter } = makeDeps({});
    expect(await run(deps)).toBe("updated");
    expect(runHostUpdate).toHaveBeenCalledOnce();
    expect(refreshAfter).toHaveBeenCalledOnce();
  });

  it("treats a non-running host (no websocket url) as idle and updates", async () => {
    const { deps, runHostUpdate, probeBusy } = makeDeps({
      websocketUrl: null,
    });
    expect(await run(deps)).toBe("updated");
    expect(probeBusy).not.toHaveBeenCalled();
    expect(runHostUpdate).toHaveBeenCalledOnce();
  });

  it("reports failure without refreshing when the update throws", async () => {
    const { deps, refreshAfter } = makeDeps({
      runHostUpdate: vi.fn().mockRejectedValue(new Error("download timeout")),
    });
    expect(await run(deps)).toBe("failed");
    expect(refreshAfter).not.toHaveBeenCalled();
  });

  it("waits for host discovery to settle before reading the snapshot (no fail-open at boot)", async () => {
    // Models the boot race: the snapshot is null until host discovery settles.
    // The idle gate must not read it before awaitHostReady resolves, or it
    // would mistake a still-loading running host for a stopped one.
    let ready = false;
    const order: string[] = [];
    const { deps, runHostUpdate, probeBusy } = makeDeps({
      awaitHostReady: vi.fn().mockImplementation(async () => {
        order.push("awaitHostReady");
        ready = true;
      }),
      getHostWebsocketUrl: vi.fn().mockImplementation(() => {
        order.push("getHostWebsocketUrl");
        // Before discovery settles the snapshot is null; after, the host is
        // present and busy.
        return ready ? "ws://127.0.0.1:5000/rpc" : null;
      }),
    });
    expect(await run(deps)).toBe("updated");
    expect(order).toEqual(["awaitHostReady", "getHostWebsocketUrl"]);
    // The post-ready (non-null) url means probeBusy is consulted, not skipped.
    expect(probeBusy).toHaveBeenCalledOnce();
    expect(runHostUpdate).toHaveBeenCalledOnce();
  });
});
