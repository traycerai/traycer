import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// `respawnIfDown` is the health monitor's automatic recovery. This suite
// drives it against a REAL `HostController` (only the CLI subprocess wrapper
// and the macOS login-item bindings are mocked) to prove the quiesce contract
// end to end: after `quiesce()` a tick reaches the CLI zero times, while the
// identical tick on an un-quiesced controller in the same "host is down"
// state does spawn.

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => join(process.env.HOME ?? "/tmp", "userData")),
    isPackaged: false,
    getAppPath: vi.fn(() => "/tmp"),
    getVersion: vi.fn(() => "9.9.9"),
  },
}));

vi.mock("electron-log", () => ({
  default: {
    transports: { file: { level: "info" }, console: { level: "info" } },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../cli/traycer-cli", () => ({
  runBundledTraycerCliJson: vi.fn(async () => ({})),
  streamBundledTraycerCliJson: vi.fn(async () => ({ data: {} })),
  spawnDetachedBundledTraycerCliJson: vi.fn(),
  TraycerCliError: class extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("../../cli/cli-discovery", () => ({
  resolveBundledCliPath: vi.fn(async () => null),
  readCliManifest: vi.fn(async () => null),
}));

vi.mock("../../app/host-login-item", () => ({
  hostManagesHostLoginItem: vi.fn(async () => false),
  registerHostLoginItem: vi.fn(async () => "enabled"),
  unregisterHostLoginItemGuarded: vi.fn(async () => true),
  retireCompetingCliRegistrationAtLaunchGuarded: vi.fn(
    async () => "not-applicable",
  ),
  hasUnappliedPendingLoginItemRevision: vi.fn(async () => false),
  readHostLoginItemStatus: vi.fn(() => "enabled"),
  readParkedRegistrationTakeover: vi.fn(async () => ({
    kind: "no-takeover",
    reason: "primary-manageable",
  })),
}));

vi.mock("../../host/host-readiness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/host-readiness")>();
  return {
    ...actual,
    waitForHostReady: vi.fn(async () => ({
      ready: true,
      version: "1.0.0",
      pid: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      reason: "ready",
    })),
  };
});

vi.mock("@traycer-clients/shared/host-client/host-activity-probe", () => ({
  probeHostActivityBusy: vi.fn(async () => false),
}));

import { streamBundledTraycerCliJson } from "../../cli/traycer-cli";
import { hostManagesHostLoginItem } from "../../app/host-login-item";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
  type HostControllerHostLifecycle,
} from "../../host/host-controller";
import { __resetHostRemovalStateForTest } from "../../host/host-removal-state";
import {
  HostRecoveryDeferredError,
  respawnIfDown,
} from "../host-health-respawn";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-health-quiesce-"));
  sandboxHome(workHome);
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  __resetHostRemovalStateForTest();
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(true);
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
    data: { data: { restarted: false } },
  });
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fakeHostLifecycle(): HostControllerHostLifecycle {
  return {
    notifyRespawning: () => undefined,
    ensureWatcherInstalled: () => undefined,
    reloadSnapshotFromDisk: async () => null,
  };
}

/** A controller whose host is down: no pid record, endpoint unreachable. */
function newDownController(): HostController {
  return new HostController({
    environment: "production",
    hostLifecycle: fakeHostLifecycle(),
    reachabilityProbe: async () => false,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
}

describe("respawnIfDown against a real HostController", () => {
  it("control: a tick on a down host reaches the CLI restart", async () => {
    const controller = newDownController();

    await respawnIfDown(controller);

    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(1);
    expect(streamBundledTraycerCliJson).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(["host", "restart"]),
      }),
    );
  });

  it("a tick after quiesce spawns nothing and re-arms the monitor via the deferred error", async () => {
    const controller = newDownController();
    controller.quiesce();

    await expect(respawnIfDown(controller)).rejects.toBeInstanceOf(
      HostRecoveryDeferredError,
    );
    await expect(respawnIfDown(controller)).rejects.toBeInstanceOf(
      HostRecoveryDeferredError,
    );

    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
  });

  it("a reversible hold suspends the tick, and releasing it restores the spawn", async () => {
    const controller = newDownController();
    const hold = controller.holdAutomaticIntents();

    await expect(respawnIfDown(controller)).rejects.toBeInstanceOf(
      HostRecoveryDeferredError,
    );
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(0);

    hold.release();
    await respawnIfDown(controller);
    expect(streamBundledTraycerCliJson).toHaveBeenCalledTimes(1);
  });
});
