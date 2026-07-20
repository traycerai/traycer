import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type {
  HostAutoUpdateDeps,
  HostAutoUpdateOperation,
  HostAutoUpdateOutcome,
} from "../host-auto-update";
import type { HostUpdateAdmission } from "../../ipc/host-management-ipc";
import type { UpdateChannelSnapshot } from "../../app/update-preferences";

// `reconcileHostAutoUpdate` is the idle-gated host updater shared by the
// launch boot phase and the quit-to-install hook. Behaviour pinned here:
//
//   - No update available / unreachable -> "up-to-date", never runs the update.
//   - Host busy -> "skipped-busy", never runs the update (protects in-progress
//     work).
//   - Host not running (no websocket url) -> idle, runs the update.
//   - Update fails -> "failed", does NOT refresh the post-update cache.
//   - Success -> "updated", runs the update then force-refreshes the cache.
//   - Cold-review findings 5/6: operation reservation wraps registry/capability
//     prework; admission binds target+generation before readiness/busy awaits;
//     a superseded channel after those awaits never spawns.

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

const DEFAULT_CHANNEL: UpdateChannelSnapshot = {
  allowPrerelease: false,
  generation: 1,
};

const DEFAULT_OPERATION: HostAutoUpdateOperation = {
  operationId: "op-auto",
  onEvent: vi.fn(),
};

function makeDeps(
  overrides: Partial<HostAutoUpdateDeps> & {
    readonly updateAvailable?: boolean;
    readonly reachable?: boolean;
    readonly latestVersion?: string | null;
    readonly includePreReleases?: boolean;
    readonly websocketUrl?: string | null;
    readonly busy?: boolean;
  },
): {
  readonly deps: HostAutoUpdateDeps;
  readonly runHostUpdate: Mock;
  readonly refreshAfter: Mock;
  readonly probeBusy: Mock;
  readonly runUpdateOperation: Mock;
  readonly captureUpdateChannel: Mock;
  readonly captureUpdateAdmission: Mock;
  readonly operation: HostAutoUpdateOperation;
  readonly channel: UpdateChannelSnapshot;
} {
  const runHostUpdate = vi.fn().mockResolvedValue(undefined);
  const refreshAfter = vi.fn().mockResolvedValue(undefined);
  const probeBusy = vi.fn().mockResolvedValue(overrides.busy ?? false);
  const channel = DEFAULT_CHANNEL;
  const operation = DEFAULT_OPERATION;
  const runUpdateOperation = vi
    .fn()
    .mockImplementation(
      async (run: (operation: HostAutoUpdateOperation) => Promise<unknown>) =>
        run(operation),
    );
  const captureUpdateChannel = vi.fn().mockReturnValue(channel);
  const captureUpdateAdmission = vi
    .fn()
    .mockImplementation(
      (
        version: string,
        includePreReleases: boolean,
        capturedChannel: UpdateChannelSnapshot,
      ): HostUpdateAdmission => ({
        targetVersion: version,
        allowPrerelease: includePreReleases,
        generation: capturedChannel.generation,
      }),
    );
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
      includePreReleases: overrides.includePreReleases ?? false,
    }),
    getHostWebsocketUrl: vi.fn(
      () =>
        (overrides.websocketUrl === undefined
          ? "ws://127.0.0.1:5000/rpc"
          : overrides.websocketUrl) as string | null,
    ),
    probeBusy,
    runUpdateOperation,
    captureUpdateChannel,
    captureUpdateAdmission,
    runHostUpdate,
    refreshAfter,
    ...overrides,
  };
  return {
    deps,
    // Prefer override mocks so assertions observe the same functions deps use.
    runHostUpdate: deps.runHostUpdate as Mock,
    refreshAfter: deps.refreshAfter as Mock,
    probeBusy: deps.probeBusy as Mock,
    runUpdateOperation: deps.runUpdateOperation as Mock,
    captureUpdateChannel: deps.captureUpdateChannel as Mock,
    captureUpdateAdmission: deps.captureUpdateAdmission as Mock,
    operation,
    channel,
  };
}

function expectedAdmission(args: {
  readonly version: string;
  readonly includePreReleases: boolean;
  readonly generation: number;
}): HostUpdateAdmission {
  return {
    targetVersion: args.version,
    allowPrerelease: args.includePreReleases,
    generation: args.generation,
  };
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
    const { deps, runHostUpdate, refreshAfter, operation } = makeDeps({});
    expect(await run(deps)).toBe("updated");
    expect(runHostUpdate).toHaveBeenCalledWith(
      expectedAdmission({
        version: "0.0.3",
        includePreReleases: false,
        generation: DEFAULT_CHANNEL.generation,
      }),
      operation,
    );
    expect(refreshAfter).toHaveBeenCalledOnce();
  });

  it("treats a non-running host (no websocket url) as idle and updates", async () => {
    const { deps, runHostUpdate, probeBusy, operation } = makeDeps({
      websocketUrl: null,
    });
    expect(await run(deps)).toBe("updated");
    expect(probeBusy).not.toHaveBeenCalled();
    expect(runHostUpdate).toHaveBeenCalledWith(
      expectedAdmission({
        version: "0.0.3",
        includePreReleases: false,
        generation: DEFAULT_CHANNEL.generation,
      }),
      operation,
    );
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
    const { deps, runHostUpdate, probeBusy, operation } = makeDeps({
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
    expect(runHostUpdate).toHaveBeenCalledWith(
      expectedAdmission({
        version: "0.0.3",
        includePreReleases: false,
        generation: DEFAULT_CHANNEL.generation,
      }),
      operation,
    );
  });

  // Cold-review finding 5: operation reservation must cover registry /
  // capability prework so concurrent windows disable before spawn.
  it("reserves the update operation before registry/readiness/busy prework", async () => {
    const order: string[] = [];
    const { deps, runUpdateOperation, captureUpdateChannel } = makeDeps({
      runUpdateOperation: vi.fn().mockImplementation(async (run) => {
        order.push("runUpdateOperation");
        return run(DEFAULT_OPERATION);
      }),
      captureUpdateChannel: vi.fn().mockImplementation(() => {
        order.push("captureUpdateChannel");
        return DEFAULT_CHANNEL;
      }),
      checkUpdateState: vi.fn().mockImplementation(async () => {
        order.push("checkUpdateState");
        return {
          checkedAt: "2026-06-23T00:00:00Z",
          latestVersion: "0.0.3",
          installedVersion: "0.0.2",
          updateAvailable: true,
          reachable: true,
          errorMessage: null,
          includePreReleases: false,
        };
      }),
      awaitHostReady: vi.fn().mockImplementation(async () => {
        order.push("awaitHostReady");
      }),
    });

    expect(await run(deps)).toBe("updated");
    expect(runUpdateOperation).toHaveBeenCalledOnce();
    expect(captureUpdateChannel).toHaveBeenCalledOnce();
    expect(order.slice(0, 4)).toEqual([
      "runUpdateOperation",
      "captureUpdateChannel",
      "checkUpdateState",
      "awaitHostReady",
    ]);
  });

  // Cold-review finding 5: bind target+generation before awaits; revalidate
  // lives in runHostUpdate after capability work.
  it("captures admission before readiness/busy awaits and reuses it at spawn", async () => {
    const order: string[] = [];
    const { deps, runHostUpdate, captureUpdateAdmission, operation } = makeDeps(
      {
        captureUpdateAdmission: vi
          .fn()
          .mockImplementation(
            (
              version: string,
              includePreReleases: boolean,
              channel: UpdateChannelSnapshot,
            ) => {
              order.push("captureUpdateAdmission");
              return {
                targetVersion: version,
                allowPrerelease: includePreReleases,
                generation: channel.generation,
              };
            },
          ),
        awaitHostReady: vi.fn().mockImplementation(async () => {
          order.push("awaitHostReady");
        }),
        probeBusy: vi.fn().mockImplementation(async () => {
          order.push("probeBusy");
          return false;
        }),
        runHostUpdate: vi.fn().mockImplementation(async () => {
          order.push("runHostUpdate");
        }),
      },
    );

    expect(await run(deps)).toBe("updated");
    expect(captureUpdateAdmission).toHaveBeenCalledWith(
      "0.0.3",
      false,
      DEFAULT_CHANNEL,
    );
    expect(runHostUpdate).toHaveBeenCalledWith(
      expectedAdmission({
        version: "0.0.3",
        includePreReleases: false,
        generation: DEFAULT_CHANNEL.generation,
      }),
      operation,
    );
    expect(order).toEqual([
      "captureUpdateAdmission",
      "awaitHostReady",
      "probeBusy",
      "runHostUpdate",
    ]);
  });

  // Real readiness→ABA→spawn-boundary race is covered by
  // host-management-channel.test.ts ("automatic host update - channel
  // admission race") using defaultHostAutoUpdateDeps + real final admission.
  // The unit fixture here only pins that a rejected runHostUpdate is failed
  // without refreshAfter; the integration race proves the stream never fires.

  it("fails when operation admission itself rejects (channel flip before capture)", async () => {
    const { deps, runHostUpdate, refreshAfter } = makeDeps({
      runUpdateOperation: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "The host update channel changed while preparing the update. Try again.",
          ),
        ),
    });

    expect(await run(deps)).toBe("failed");
    expect(runHostUpdate).not.toHaveBeenCalled();
    expect(refreshAfter).not.toHaveBeenCalled();
  });
});

// Ticket: host-update-race-conditions. `runHostUpdate` used to call
// `streamTraycerCliJson` directly, so a launch/quit-time coordinated update
// held the CLI lock but was completely invisible to every renderer window -
// a manual click during that window would spawn a second `traycer host
// update` and lose the race. It now goes through the same
// operation-reservation seam (and thus the same in-main single-flight
// guard + `hostOperationStatusChange` broadcast) as every renderer-triggered
// operation, so the background update disables/shows-progress-on every
// surface instead of silently racing them.
vi.mock("../../ipc/host-management-ipc", () => ({
  refreshRegistryUpdateState: vi.fn().mockResolvedValue({
    checkedAt: "2026-06-23T00:00:00Z",
    latestVersion: "0.0.3",
    installedVersion: "0.0.2",
    updateAvailable: true,
    reachable: true,
    errorMessage: null,
    includePreReleases: false,
  }),
  streamCliWithProgress: vi.fn().mockResolvedValue({}),
  streamExactHostUpdateWithinOperation: vi.fn().mockResolvedValue({}),
  runHostOperation: vi.fn(
    async (
      _bridge: unknown,
      _kind: string,
      operationId: string,
      run: (onEvent: (event: unknown) => void) => Promise<unknown>,
    ) => run(vi.fn()),
  ),
  captureHostUpdateChannel: vi.fn(() => DEFAULT_CHANNEL),
  captureHostUpdateAdmission: vi.fn(
    (
      version: string,
      includePreReleases: boolean,
      channel: UpdateChannelSnapshot,
    ) => ({
      targetVersion: version,
      allowPrerelease: includePreReleases,
      generation: channel.generation,
    }),
  ),
}));

vi.mock("../../cli/host-update-cli", async () => {
  const actual = await vi.importActual<
    typeof import("../../cli/host-update-cli")
  >("../../cli/host-update-cli");
  return {
    ...actual,
    resolveExactHostUpdateCli: vi.fn().mockResolvedValue({
      command: "/mock/traycer",
      args: [],
    }),
  };
});

describe("defaultHostAutoUpdateDeps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the update through streamExactHostUpdateWithinOperation with the bound admission", async () => {
    const { defaultHostAutoUpdateDeps } = await import("../host-auto-update");
    const { streamExactHostUpdateWithinOperation } =
      await import("../../ipc/host-management-ipc");
    const host = { getSnapshot: () => null } as never;
    const bridge = { fanOut: vi.fn() } as never;
    const deps = defaultHostAutoUpdateDeps(
      host,
      12345,
      () => Promise.resolve(),
      bridge,
    );
    const admission = expectedAdmission({
      version: "0.0.3-rc.2",
      includePreReleases: true,
      generation: 4,
    });
    const onEvent = vi.fn();

    await deps.runHostUpdate(admission, {
      operationId: "op-default",
      onEvent,
    });

    expect(streamExactHostUpdateWithinOperation).toHaveBeenCalledWith(
      ["host", "update", "--release", "0.0.3-rc.2"],
      12345,
      { command: "/mock/traycer", args: [] },
      onEvent,
      "op-default",
      admission,
    );
  });

  // Review findings 4/6: background auto-update pins the exact selected
  // version via `--release` and always capability-resolves the CLI first —
  // never bare `host update`.
  it("capability-resolves the CLI then pins the exact version with --release (never bare host update)", async () => {
    const { defaultHostAutoUpdateDeps } = await import("../host-auto-update");
    const { streamExactHostUpdateWithinOperation } =
      await import("../../ipc/host-management-ipc");
    const { resolveExactHostUpdateCli, exactHostUpdateArgs } =
      await import("../../cli/host-update-cli");
    const host = { getSnapshot: () => null } as never;
    const bridge = { fanOut: vi.fn() } as never;
    const deps = defaultHostAutoUpdateDeps(
      host,
      999,
      () => Promise.resolve(),
      bridge,
    );
    const admission = expectedAdmission({
      version: "1.5.0-rc.3",
      includePreReleases: true,
      generation: 2,
    });

    await deps.runHostUpdate(admission, {
      operationId: "op-exact",
      onEvent: vi.fn(),
    });

    expect(resolveExactHostUpdateCli).toHaveBeenCalledOnce();
    expect(streamExactHostUpdateWithinOperation).toHaveBeenCalledWith(
      exactHostUpdateArgs("1.5.0-rc.3"),
      999,
      { command: "/mock/traycer", args: [] },
      expect.any(Function),
      "op-exact",
      admission,
    );
    const [args] =
      vi.mocked(streamExactHostUpdateWithinOperation).mock.calls[0] ?? [];
    expect(args).toEqual(["host", "update", "--release", "1.5.0-rc.3"]);
    expect(args).not.toEqual(["host", "update"]);
  });

  it("checkUpdateState reads the cache without forcing and without overriding the freshness threshold", async () => {
    const { defaultHostAutoUpdateDeps } = await import("../host-auto-update");
    const { refreshRegistryUpdateState } =
      await import("../../ipc/host-management-ipc");
    const host = { getSnapshot: () => null } as never;
    const bridge = { fanOut: vi.fn() } as never;
    const deps = defaultHostAutoUpdateDeps(
      host,
      12345,
      () => Promise.resolve(),
      bridge,
    );

    await deps.checkUpdateState();

    expect(refreshRegistryUpdateState).toHaveBeenCalledWith({
      force: false,
      maxAgeMs: null,
    });
  });

  it("refreshAfter force-refreshes the cache after a successful update", async () => {
    const { defaultHostAutoUpdateDeps } = await import("../host-auto-update");
    const { refreshRegistryUpdateState } =
      await import("../../ipc/host-management-ipc");
    const host = { getSnapshot: () => null } as never;
    const bridge = { fanOut: vi.fn() } as never;
    const deps = defaultHostAutoUpdateDeps(
      host,
      12345,
      () => Promise.resolve(),
      bridge,
    );

    await deps.refreshAfter();

    expect(refreshRegistryUpdateState).toHaveBeenCalledWith({
      force: true,
      maxAgeMs: null,
    });
  });

  it("runUpdateOperation reserves the shared host operation before the work body", async () => {
    const { defaultHostAutoUpdateDeps } = await import("../host-auto-update");
    const { runHostOperation } = await import("../../ipc/host-management-ipc");
    const host = { getSnapshot: () => null } as never;
    const bridge = { fanOut: vi.fn() } as never;
    const deps = defaultHostAutoUpdateDeps(
      host,
      12345,
      () => Promise.resolve(),
      bridge,
    );

    const body = vi.fn().mockResolvedValue("ok");
    await expect(deps.runUpdateOperation(body)).resolves.toBe("ok");

    expect(runHostOperation).toHaveBeenCalledWith(
      bridge,
      "update",
      expect.any(String),
      expect.any(Function),
    );
    expect(body).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.any(String),
        onEvent: expect.any(Function),
      }),
    );
  });
});
