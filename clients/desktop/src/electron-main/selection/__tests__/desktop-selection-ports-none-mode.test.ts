import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthorityIdentitySource,
  SelectionSubscription,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import type { AuthorityLog } from "@traycer-clients/shared/host-selection/selection-authority-engine";
import type { HostListItem } from "@traycer/protocol/host/host-status";
import type {
  DesktopPublishedHostSnapshot,
  RegisteredHostsPush,
} from "../../../ipc-contracts/host-types";
import type { DesktopAuthSessionSnapshot } from "../../../ipc-contracts/window-types";
import type {
  ConvergeReadyOk,
  ConvergeReadyVersionPolicy,
  LocalHostMutationIntent,
  MutationOutcome,
} from "../../host/host-controller-types";
import type { IpcHostLifecycle } from "../../ipc/runner-ipc-bridge";
import { FakeHostController } from "../../ipc/__tests__/fake-host-controller";
import { sandboxHome } from "../../__tests__/sandbox-home";

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

import {
  runBundledTraycerCliJson,
  streamBundledTraycerCliJson,
} from "../../cli/traycer-cli";
import { hostManagesHostLoginItem } from "../../app/host-login-item";
import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
} from "../../host/host-controller";
import { __resetHostRemovalStateForTest } from "../../host/host-removal-state";
import { setAppliedLocalHostCapability } from "../../host/local-host-capability";
import { DesktopAuthSession } from "../../auth/desktop-auth-session";
import {
  createDesktopLocalHostEnsurePort,
  DesktopHostFleetSource,
} from "../desktop-selection-ports";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "selection-ports-none-"));
  sandboxHome(workHome);
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  __resetHostRemovalStateForTest();
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
  vi.mocked(runBundledTraycerCliJson).mockResolvedValue({});
  vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({ data: {} });
});

afterEach(() => {
  setAppliedLocalHostCapability("managed");
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

const silentLog: AuthorityLog = {
  debug: () => undefined,
  warn: () => undefined,
};

// ---------------------------------------------------------------------------
// Fleet source
// ---------------------------------------------------------------------------

class FakeIdentitySource implements AuthorityIdentitySource {
  current(): { identityKey: string | null; generation: number } {
    return { identityKey: "identity-a", generation: 0 };
  }
  onChanged(): SelectionSubscription {
    return { dispose: () => undefined };
  }
}

class FakeHostLifecycle extends EventEmitter implements IpcHostLifecycle {
  pidMetadataFile = "/tmp/selection-ports-none/pid.json";
  identityEnrollmentFile = "/tmp/selection-ports-none/enrollment.json";
  isDisposed = false;

  getSnapshot(): DesktopPublishedHostSnapshot | null {
    return null;
  }
  notifyRespawning(): void {}
  noteEndpointAnswered(): void {}
  ensureWatcherInstalled(): void {}
  async reloadSnapshotFromDisk(): Promise<DesktopPublishedHostSnapshot | null> {
    return null;
  }
  async getRecentLogTail(_maxLines: number): Promise<string | null> {
    return null;
  }
}

function signedInSnapshot(): DesktopAuthSessionSnapshot {
  return {
    status: "signed-in",
    token: "token-1",
    profile: {
      userId: "user-a",
      userName: "user-a",
      email: "user-a@example.com",
    },
  };
}

function buildHostListItem(hostId: string): HostListItem {
  return {
    hostId,
    displayName: null,
    platform: null,
    kind: "personal",
    publicKey: "pub-key",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion: null,
      lastSeenAt: null,
    },
    updatePolicy: "manual",
  };
}

function buildFleetSource(host: FakeHostLifecycle): DesktopHostFleetSource {
  const authSession = new DesktopAuthSession();
  authSession.setVerified(signedInSnapshot(), authSession.beginSet());
  const published: RegisteredHostsPush[] = [];
  return new DesktopHostFleetSource({
    authnBaseUrl: "http://localhost:5005",
    identity: new FakeIdentitySource(),
    authSession,
    host,
    listRegisteredHosts: async () => ({
      kind: "ok",
      response: {
        hosts: [
          buildHostListItem("local-host"),
          buildHostListItem("remote-host"),
        ],
      },
    }),
    publishRegistryResponse: (push) => {
      published.push(push);
    },
    now: () => 1_000,
    log: silentLog,
  });
}

function hostWithEnrollment(hostId: string): FakeHostLifecycle {
  const identityDir = join(workHome, "identity");
  mkdirSync(identityDir, { recursive: true });
  const file = join(identityDir, "enrollment.json");
  writeFileSync(file, JSON.stringify({ hostId }), "utf8");
  const host = new FakeHostLifecycle();
  host.identityEnrollmentFile = file;
  host.pidMetadataFile = join(workHome, "pid.json");
  return host;
}

describe("DesktopHostFleetSource in none mode", () => {
  it("managed: names the enrolled host local (control)", async () => {
    setAppliedLocalHostCapability("managed");
    const fleet = buildFleetSource(hostWithEnrollment("local-host"));

    await fleet.refresh();

    const snapshot = fleet.snapshot();
    expect(snapshot.localHostId).toBe("local-host");
    expect(snapshot.hosts).toEqual([
      { hostId: "local-host", kind: "local" },
      { hostId: "remote-host", kind: "remote" },
    ]);
    fleet.dispose();
  });

  it("none: localHostId is null and no entry is local, even with an enrollment record", async () => {
    setAppliedLocalHostCapability("none");
    const fleet = buildFleetSource(hostWithEnrollment("local-host"));

    await fleet.refresh();

    const snapshot = fleet.snapshot();
    expect(snapshot.localHostId).toBeNull();
    expect(snapshot.hosts.some((entry) => entry.kind === "local")).toBe(false);
    expect(snapshot.hosts).toEqual([
      { hostId: "local-host", kind: "remote" },
      { hostId: "remote-host", kind: "remote" },
    ]);
    fleet.dispose();
  });
});

// ---------------------------------------------------------------------------
// Ensure port
// ---------------------------------------------------------------------------

class CountingHostController extends FakeHostController {
  convergeReadyCalls = 0;

  override async convergeReady(
    _force: boolean,
    _intent: LocalHostMutationIntent,
    _versionPolicy: ConvergeReadyVersionPolicy,
  ): Promise<MutationOutcome<ConvergeReadyOk>> {
    this.convergeReadyCalls += 1;
    return { kind: "ok", value: { running: true, version: "1.0.0" } };
  }
}

describe("createDesktopLocalHostEnsurePort in none mode", () => {
  it("managed: converges once and reports ok (control)", async () => {
    setAppliedLocalHostCapability("managed");
    const controller = new CountingHostController();
    const port = createDesktopLocalHostEnsurePort(controller);

    await expect(port.ensureReady()).resolves.toEqual({ ok: true });
    expect(controller.convergeReadyCalls).toBe(1);
  });

  it("none: refuses as unavailable, not deferred, with zero convergeReady calls", async () => {
    setAppliedLocalHostCapability("none");
    const controller = new CountingHostController();
    const port = createDesktopLocalHostEnsurePort(controller);

    await expect(port.ensureReady()).resolves.toEqual({
      ok: false,
      reason: "local-provisioning-unavailable",
      deferred: false,
    });
    expect(controller.convergeReadyCalls).toBe(0);
  });
});

describe("createDesktopLocalHostEnsurePort against a quiesced real controller", () => {
  function newRealController(): HostController {
    return new HostController({
      environment: "production",
      hostLifecycle: {
        notifyRespawning: () => undefined,
        ensureWatcherInstalled: () => undefined,
        reloadSnapshotFromDisk: async () => null,
      },
      reachabilityProbe: async () => false,
      desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
      desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
    });
  }

  it("control: an un-quiesced controller's ensure reaches the CLI", async () => {
    setAppliedLocalHostCapability("managed");
    vi.mocked(streamBundledTraycerCliJson).mockResolvedValue({
      data: { running: true, version: "1.7.0", action: "noop" },
    });
    const port = createDesktopLocalHostEnsurePort(newRealController());

    await port.ensureReady();

    expect(streamBundledTraycerCliJson).toHaveBeenCalled();
  });

  it("after quiesce the ensure is deferred and never spawns the CLI", async () => {
    setAppliedLocalHostCapability("managed");
    const controller = newRealController();
    controller.quiesce();
    const port = createDesktopLocalHostEnsurePort(controller);

    const result = await port.ensureReady();

    expect(result).toEqual(
      expect.objectContaining({ ok: false, deferred: true }),
    );
    expect(streamBundledTraycerCliJson).not.toHaveBeenCalled();
    expect(runBundledTraycerCliJson).not.toHaveBeenCalled();
  });
});
