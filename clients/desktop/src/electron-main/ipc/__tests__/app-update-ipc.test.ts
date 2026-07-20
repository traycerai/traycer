import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// Review finding 5: a successfully persisted release-channel change must
// force-refresh the main-process Host registry (fanning the new channel's
// state out to every window and the native menu/tray) BEFORE the Desktop
// updater re-checks - otherwise a window or the tray can still be showing a
// target resolved under the previous channel when main resolves a different
// one. A refusal (update downloading/staged) or a no-op (channel unchanged)
// must not trigger either side effect, and a registry-probe failure must
// never fail an already-persisted preference change.

const updater = vi.hoisted(() => ({
  setAllowPrereleaseUpdates: vi.fn(),
  checkForUpdatesNow: vi.fn(),
  getAppUpdateSnapshot: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  startUpdateDownload: vi.fn(),
  onAppUpdateChange: vi.fn(() => () => undefined),
}));

const hostManagementIpc = vi.hoisted(() => ({
  refreshRegistryUpdateState: vi.fn(),
}));

const preferenceErrors = vi.hoisted(() => ({
  isUpdatePreferencePersistenceError: vi.fn(),
}));

const logger = vi.hoisted(() => ({
  describeLogError: vi.fn((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  })),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../config", () => ({ isDevBuild: false }));

vi.mock("../../app/updater", () => ({
  setAllowPrereleaseUpdates: updater.setAllowPrereleaseUpdates,
  checkForUpdatesNow: updater.checkForUpdatesNow,
  getAppUpdateSnapshot: updater.getAppUpdateSnapshot,
  installDownloadedUpdate: updater.installDownloadedUpdate,
  startUpdateDownload: updater.startUpdateDownload,
  onAppUpdateChange: updater.onAppUpdateChange,
}));

vi.mock("../host-management-ipc", () => ({
  refreshRegistryUpdateState: hostManagementIpc.refreshRegistryUpdateState,
}));

vi.mock("../../app/update-preferences", () => ({
  isUpdatePreferencePersistenceError:
    preferenceErrors.isUpdatePreferencePersistenceError,
}));

vi.mock("../../app/logger", () => logger);

interface FakeBridge {
  readonly handlers: Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >;
  readonly fanOut: Mock;
  readonly disposeFns: Array<() => void>;
  handleInvoke(
    channel: string,
    handler: (event: unknown, raw: unknown) => unknown,
  ): void;
}

function makeBridge(): FakeBridge {
  const handlers = new Map<
    string,
    (event: unknown, raw: unknown) => Promise<unknown>
  >();
  return {
    handlers,
    fanOut: vi.fn(),
    disposeFns: [],
    handleInvoke(channel, handler) {
      handlers.set(channel, async (event, raw) => handler(event, raw));
    },
  };
}

function snapshotFixture(allowPrerelease: boolean): {
  readonly allowPrerelease: boolean;
} {
  return { allowPrerelease };
}

beforeEach(() => {
  vi.resetModules();
  updater.setAllowPrereleaseUpdates.mockReset();
  updater.checkForUpdatesNow.mockReset();
  updater.getAppUpdateSnapshot.mockReset();
  updater.installDownloadedUpdate.mockReset();
  updater.startUpdateDownload.mockReset();
  updater.onAppUpdateChange.mockReset().mockReturnValue(() => undefined);
  hostManagementIpc.refreshRegistryUpdateState.mockReset();
  preferenceErrors.isUpdatePreferencePersistenceError.mockReset();
  logger.describeLogError.mockClear();
  logger.log.debug.mockReset();
  logger.log.info.mockReset();
  logger.log.warn.mockReset();
  logger.log.error.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function invokeSetAllowPrerelease(
  allowPrerelease: boolean,
): Promise<{ readonly bridge: FakeBridge; readonly result: Promise<unknown> }> {
  const { registerAppUpdateIpc } = await import("../app-update-ipc");
  const { RunnerHostInvoke } =
    await import("../../../ipc-contracts/ipc-channels");
  const bridge = makeBridge();
  registerAppUpdateIpc(bridge as never);
  const handler = bridge.handlers.get(
    RunnerHostInvoke.appUpdateSetAllowPrerelease,
  );
  if (handler === undefined) {
    throw new Error("appUpdateSetAllowPrerelease handler was not registered");
  }
  return { bridge, result: handler(null, allowPrerelease) };
}

describe("app-update IPC - channel change orchestration (review finding 5)", () => {
  it("force-refreshes the Host registry and awaits it BEFORE running the Desktop check on a durable channel change", async () => {
    const order: string[] = [];
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "changed",
      snapshot: snapshotFixture(true),
    });
    let releaseRefresh: () => void = () => undefined;
    hostManagementIpc.refreshRegistryUpdateState.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () => {
            order.push("registry-refresh-resolved");
            resolve({ reachable: true });
          };
        }),
    );
    updater.checkForUpdatesNow.mockImplementation(() => {
      order.push("desktop-check");
      return Promise.resolve(snapshotFixture(true));
    });

    const { result } = await invokeSetAllowPrerelease(true);

    // The registry refresh must be in flight (and NOT yet the Desktop check)
    // immediately after the mutation starts.
    expect(hostManagementIpc.refreshRegistryUpdateState).toHaveBeenCalledWith({
      force: true,
      maxAgeMs: null,
    });
    expect(updater.checkForUpdatesNow).not.toHaveBeenCalled();

    releaseRefresh();
    await result;

    expect(order).toEqual(["registry-refresh-resolved", "desktop-check"]);
    expect(updater.checkForUpdatesNow).toHaveBeenCalledWith(false, "manual");
  });

  it("returns the Desktop check's snapshot as the mutation result on a durable change", async () => {
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "changed",
      snapshot: snapshotFixture(true),
    });
    hostManagementIpc.refreshRegistryUpdateState.mockResolvedValue({
      reachable: true,
    });
    const checkedSnapshot = snapshotFixture(true);
    updater.checkForUpdatesNow.mockResolvedValue(checkedSnapshot);

    const { result } = await invokeSetAllowPrerelease(true);

    await expect(result).resolves.toBe(checkedSnapshot);
  });

  it("does not refresh the registry or run a Desktop check when the requested channel was already active (unchanged)", async () => {
    const unchangedSnapshot = snapshotFixture(false);
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "unchanged",
      snapshot: unchangedSnapshot,
    });

    const { result } = await invokeSetAllowPrerelease(false);

    await expect(result).resolves.toBe(unchangedSnapshot);
    expect(hostManagementIpc.refreshRegistryUpdateState).not.toHaveBeenCalled();
    expect(updater.checkForUpdatesNow).not.toHaveBeenCalled();
  });

  it("rejects the invoke with the refusal message and runs neither side effect when an update is downloading/staged", async () => {
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "refused-update-pending",
      snapshot: snapshotFixture(true),
    });

    const { result } = await invokeSetAllowPrerelease(false);
    const { CHANNEL_CHANGE_REFUSED_MESSAGE } =
      await import("../app-update-ipc");

    await expect(result).rejects.toThrow(CHANNEL_CHANGE_REFUSED_MESSAGE);
    expect(hostManagementIpc.refreshRegistryUpdateState).not.toHaveBeenCalled();
    expect(updater.checkForUpdatesNow).not.toHaveBeenCalled();
  });

  it("logs persistence failures in main and returns fixed safe copy to the renderer", async () => {
    const filesystemError = new Error(
      "EACCES: permission denied, rename '/Users/alice/Library/Application Support/Traycer/update-preferences.json'",
    );
    const persistenceError = { cause: filesystemError };
    updater.setAllowPrereleaseUpdates.mockRejectedValue(persistenceError);
    preferenceErrors.isUpdatePreferencePersistenceError.mockReturnValue(true);

    const { result } = await invokeSetAllowPrerelease(true);
    const { CHANNEL_PREFERENCE_SAVE_FAILED_MESSAGE } =
      await import("../app-update-ipc");

    const failure = await result.then(
      () => null,
      (error) => error,
    );

    expect(failure).toHaveProperty(
      "message",
      CHANNEL_PREFERENCE_SAVE_FAILED_MESSAGE,
    );
    expect(failure).not.toHaveProperty("message", filesystemError.message);
    expect(
      preferenceErrors.isUpdatePreferencePersistenceError,
    ).toHaveBeenCalledWith(persistenceError);
    expect(logger.describeLogError).toHaveBeenCalledWith(filesystemError);
    expect(logger.log.error).toHaveBeenCalledWith(
      "[app-update] failed to persist release channel preference",
      { error: { message: filesystemError.message } },
    );
    expect(hostManagementIpc.refreshRegistryUpdateState).not.toHaveBeenCalled();
    expect(updater.checkForUpdatesNow).not.toHaveBeenCalled();
  });

  it("preserves a post-persist feed reconfiguration failure", async () => {
    const feedError = new Error("stable feed reconfiguration failed");
    updater.setAllowPrereleaseUpdates.mockRejectedValue(feedError);
    preferenceErrors.isUpdatePreferencePersistenceError.mockReturnValue(false);

    const { result } = await invokeSetAllowPrerelease(false);

    await expect(result).rejects.toBe(feedError);
    expect(
      preferenceErrors.isUpdatePreferencePersistenceError,
    ).toHaveBeenCalledWith(feedError);
    expect(logger.describeLogError).not.toHaveBeenCalled();
    expect(logger.log.error).not.toHaveBeenCalled();
    expect(hostManagementIpc.refreshRegistryUpdateState).not.toHaveBeenCalled();
    expect(updater.checkForUpdatesNow).not.toHaveBeenCalled();
  });

  it("still runs the Desktop check after a registry-probe failure - the already-persisted preference change is not failed", async () => {
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "changed",
      snapshot: snapshotFixture(true),
    });
    hostManagementIpc.refreshRegistryUpdateState.mockRejectedValue(
      new Error("registry probe failed"),
    );
    const checkedSnapshot = snapshotFixture(true);
    updater.checkForUpdatesNow.mockResolvedValue(checkedSnapshot);

    const { result } = await invokeSetAllowPrerelease(true);

    await expect(result).resolves.toBe(checkedSnapshot);
    expect(updater.checkForUpdatesNow).toHaveBeenCalledWith(false, "manual");
  });

  it("coerces a non-boolean invoke argument to false rather than throwing", async () => {
    updater.setAllowPrereleaseUpdates.mockResolvedValue({
      outcome: "unchanged",
      snapshot: snapshotFixture(false),
    });
    const { registerAppUpdateIpc } = await import("../app-update-ipc");
    const { RunnerHostInvoke } =
      await import("../../../ipc-contracts/ipc-channels");
    const bridge = makeBridge();
    registerAppUpdateIpc(bridge as never);
    const handler = bridge.handlers.get(
      RunnerHostInvoke.appUpdateSetAllowPrerelease,
    );
    if (handler === undefined) {
      throw new Error("appUpdateSetAllowPrerelease handler was not registered");
    }

    await handler(null, undefined);

    expect(updater.setAllowPrereleaseUpdates).toHaveBeenCalledWith(false);
  });
});
