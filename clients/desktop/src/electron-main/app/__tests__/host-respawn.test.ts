import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeStatus {
  state: "running" | "stopped" | "not-installed";
  version: string | null;
  listenUrl: string | null;
  pid: number | null;
}

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const hostManagesHostLoginItem = vi.fn<() => Promise<boolean>>();
const registerHostLoginItem = vi.fn<() => Promise<string>>();
const readHostLoginItemStatus = vi.fn<() => string>();

vi.mock("../host-login-item", () => ({
  hostManagesHostLoginItem: () => hostManagesHostLoginItem(),
  registerHostLoginItem: () => registerHostLoginItem(),
  readHostLoginItemStatus: () => readHostLoginItemStatus(),
}));

// The removal sentinel reads `app.getPath("userData")`; these unit tests
// exercise the live respawn path, so stub it to "not removed" (the default).
vi.mock("../../host/host-removal-state", () => ({
  isHostRemovedByUser: () => Promise.resolve(false),
}));

const waitForHostReady = vi.fn<
  (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
  ) => Promise<{
    ready: boolean;
    version: string | null;
    pid: number | null;
    reason: string;
  }>
>();

vi.mock("../../host/host-readiness", () => ({
  waitForHostReady: (
    timeoutMs: number,
    pidPath: string,
    pollIntervalMs: number,
    skipPid: number | null,
  ) => waitForHostReady(timeoutMs, pidPath, pollIntervalMs, skipPid),
  HOST_READY_TIMEOUT_MS: 60_000,
  HOST_READY_POLL_MS: 250,
}));

const { respawnHost, approvalRequiredMessage } =
  await import("../host-respawn");

class FakeHost extends EventEmitter {
  respawnCalls = 0;
  notifyRespawningCalls = 0;
  reloadSnapshotCalls = 0;
  ensureWatcherCalls = 0;
  isDisposed = false;
  readonly pidMetadataFile = "/tmp/fake-traycer/pid.json";
  serviceStatus: FakeStatus = {
    state: "running",
    version: "1.0.0",
    listenUrl: "ws://127.0.0.1:1234/rpc",
    pid: 42,
  };

  getSnapshot(): null {
    return null;
  }
  async respawn(): Promise<void> {
    this.respawnCalls += 1;
  }
  notifyRespawning(): void {
    this.notifyRespawningCalls += 1;
  }
  async reloadSnapshotFromDisk(): Promise<null> {
    this.reloadSnapshotCalls += 1;
    return this.getSnapshot();
  }
  ensureWatcherInstalled(): void {
    this.ensureWatcherCalls += 1;
  }
  async getServiceStatus(): Promise<FakeStatus> {
    return this.serviceStatus;
  }
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

beforeEach(() => {
  hostManagesHostLoginItem.mockReset();
  registerHostLoginItem.mockReset();
  readHostLoginItemStatus.mockReset();
  waitForHostReady.mockReset();
});

describe("respawnHost - non-host-owned-login-item path", () => {
  it("delegates to host.respawn() when host does not own the login item", async () => {
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValueOnce(false);

    await respawnHost(host);

    expect(host.respawnCalls).toBe(1);
    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(waitForHostReady).not.toHaveBeenCalled();
  });
});

describe("respawnHost - host-owned login item path", () => {
  it("on success: cycles the login item, waits for readiness, then refreshes the lifecycle snapshot + watcher so the renderer sees the host as up", async () => {
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValueOnce(true);
    registerHostLoginItem.mockResolvedValueOnce("enabled");
    waitForHostReady.mockResolvedValueOnce({
      ready: true,
      version: "1.0.0",
      pid: 99,
      reason: "ready",
    });

    await respawnHost(host);

    expect(host.notifyRespawningCalls).toBe(1);
    expect(registerHostLoginItem).toHaveBeenCalledOnce();
    // Verifies the pre-respawn pid (42) was captured and forwarded as
    // skipPid so the readiness poll doesn't return early against the
    // still-bound old host.
    expect(waitForHostReady).toHaveBeenCalledWith(
      60_000,
      host.pidMetadataFile,
      250,
      42,
    );
    // Defense-in-depth: don't rely on fs.watch - force-refresh.
    expect(host.ensureWatcherCalls).toBe(1);
    expect(host.reloadSnapshotCalls).toBe(1);
    // CLI restart is the wrong tool here and must NOT be invoked.
    expect(host.respawnCalls).toBe(0);
  });

  it("throws the actionable approval-required message when SMAppService reports the login item is disabled by the user", async () => {
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValueOnce(true);
    registerHostLoginItem.mockResolvedValueOnce("requires-approval");

    await expect(respawnHost(host)).rejects.toThrow(approvalRequiredMessage());
    expect(waitForHostReady).not.toHaveBeenCalled();
  });

  it("returns silently (no error, no readiness wait) when the locked register cycle reports removed-by-user mid-respawn", async () => {
    // "Remove Traycer" ran while this respawn waited on the registration
    // lock - the cycle refused to resurrect the login item, and the respawn
    // must treat that like its own entry check: skip, don't error.
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValueOnce(true);
    registerHostLoginItem.mockResolvedValueOnce("removed-by-user");

    await expect(respawnHost(host)).resolves.toBeUndefined();
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(host.respawnCalls).toBe(0);
  });

  it("re-reads login-item status after a readiness timeout and substitutes the approval message when the user toggled it off mid-wait", async () => {
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValueOnce(true);
    registerHostLoginItem.mockResolvedValueOnce("enabled");
    waitForHostReady.mockResolvedValueOnce({
      ready: false,
      version: null,
      pid: null,
      reason: "pid metadata never appeared",
    });
    readHostLoginItemStatus.mockReturnValueOnce("requires-approval");

    await expect(respawnHost(host)).rejects.toThrow(approvalRequiredMessage());
  });

  it("dedups concurrent invocations - two simultaneous calls share the same in-flight promise and run only one SMAppService cycle", async () => {
    const host = new FakeHost();
    hostManagesHostLoginItem.mockResolvedValue(true);
    registerHostLoginItem.mockResolvedValueOnce("enabled");
    waitForHostReady.mockResolvedValueOnce({
      ready: true,
      version: "1.0.0",
      pid: 99,
      reason: "ready",
    });

    await Promise.all([respawnHost(host), respawnHost(host)]);

    expect(registerHostLoginItem).toHaveBeenCalledOnce();
    expect(waitForHostReady).toHaveBeenCalledOnce();
    expect(host.notifyRespawningCalls).toBe(1);
  });

  it("short-circuits when the lifecycle is disposed before the cycle starts - no SMAppService mutation, no readiness wait", async () => {
    const host = new FakeHost();
    host.isDisposed = true;
    hostManagesHostLoginItem.mockResolvedValueOnce(true);

    await respawnHost(host);

    expect(registerHostLoginItem).not.toHaveBeenCalled();
    expect(waitForHostReady).not.toHaveBeenCalled();
    expect(host.notifyRespawningCalls).toBe(0);
  });

  it("forwards `null` as skipPid when there is no prior running host (cold start) so the first observed pid.json is accepted", async () => {
    const host = new FakeHost();
    host.serviceStatus = {
      state: "not-installed",
      version: null,
      listenUrl: null,
      pid: null,
    };
    hostManagesHostLoginItem.mockResolvedValueOnce(true);
    registerHostLoginItem.mockResolvedValueOnce("enabled");
    waitForHostReady.mockResolvedValueOnce({
      ready: true,
      version: "1.0.0",
      pid: 1,
      reason: "ready",
    });

    await respawnHost(host);

    expect(waitForHostReady).toHaveBeenCalledWith(
      60_000,
      host.pidMetadataFile,
      250,
      null,
    );
  });
});
