import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installHostWakeRecovery,
  refreshHostAfterWake,
  type PowerMonitorWakeHandlers,
} from "../host-wake-recovery";

vi.mock("../../app/logger", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("installHostWakeRecovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes host watcher and pid snapshot on resume and fans the wake to the renderer on resume + unlock", () => {
    vi.useFakeTimers();
    const installed: PowerMonitorWakeHandlers[] = [];
    const host = {
      ensureWatcherInstalled: vi.fn(),
      reloadSnapshotFromDisk: vi.fn(async () => undefined),
    };
    const onWake = vi.fn();

    installHostWakeRecovery(
      host,
      (handlers) => {
        installed.push(handlers);
      },
      onWake,
    );

    const handlers = installed[0];
    if (handlers === undefined) {
      throw new Error("power monitor handlers were not installed");
    }
    handlers.onResume();

    expect(host.ensureWatcherInstalled).toHaveBeenCalledTimes(1);
    expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);
    // The renderer fan-out fires on resume, and again on screen-unlock - both
    // through this single power-monitor registration (no duplicate listeners).
    expect(onWake).toHaveBeenCalledTimes(1);
    handlers.onUnlockScreen();
    expect(onWake).toHaveBeenCalledTimes(2);
    return vi.advanceTimersByTimeAsync(4_250).then(() => {
      expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(4);
    });
  });

  it("retries wake refresh when the host is not reachable immediately", async () => {
    vi.useFakeTimers();
    const host = {
      ensureWatcherInstalled: vi.fn(),
      reloadSnapshotFromDisk: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("host still resuming"))
        .mockResolvedValue(undefined),
    };

    const refresh = refreshHostAfterWake(host);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.ensureWatcherInstalled).toHaveBeenCalledTimes(1);
    expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3_000);
    await refresh;
    expect(host.reloadSnapshotFromDisk).toHaveBeenCalledTimes(4);
  });
});
