import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// SSH-USERDOMAIN-WORKGROUP (coordinator-required test #2): `host-install.ts`
// / `host-ensure.ts` now return `exitCode: 1` when the post-swap service
// start failed, and the desktop's streaming CLI runner
// (`streamTraycerCliJsonWithInvocation` in `../../cli/traycer-cli.ts`) trusts
// a completed terminal `ok` result over that non-zero exit (`sawTerminalOk`).
// Every OTHER `HostController` suite (`host-controller.test.ts`) mocks
// `../../cli/traycer-cli` wholesale, so `streamBundledTraycerCliJson` never
// really runs and the exit code never reaches `convergeReadyCliOwned`'s
// `postSwapError` mapping (Fixup B7) - a regression that reintroduced
// "non-zero exit throws away a parsed ok payload" (S6 in this finding's
// ablation set) would still show every one of those tests green.
//
// This file leaves `../../cli/traycer-cli` UNMOCKED and fakes only the
// `node:child_process` spawn beneath it (the same seam
// `traycer-cli-envelope.test.ts` drives), so `HostController.convergeReady`
// runs through the REAL streaming runner end to end: a fake child emits a
// terminal ok `host ensure` envelope carrying `postSwapError`, then exits
// non-zero, and the assertion is that the controller still reports the
// service-start failure (not silently "ok" from a thrown-away exit, and not
// a generic "no terminal result" failure from a runner that stopped trusting
// the envelope).

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

// Deliberately NOT mocked: `../../cli/traycer-cli`. The real
// `streamBundledTraycerCliJson` / `resolveBundledTraycerCliInvocation` run,
// and only the OS-level spawn underneath them is faked below.

vi.mock("../../cli/cli-discovery", () => ({
  // Non-null so `resolveBundledTraycerCliInvocation` resolves without
  // touching the filesystem - the returned path is never opened, only
  // handed to the mocked `spawn`.
  resolveBundledCliPath: vi.fn(
    async () => "/tmp/traycer-test/bundled-cli/traycer",
  ),
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

vi.mock("../host-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../host-readiness")>();
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

vi.mock("../../app/update-preferences", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../app/update-preferences")>();
  return {
    ...actual,
    prereleaseUpdatesEnabled: vi.fn(() => false),
  };
});

interface FakeChildOptions {
  readonly stdoutLines: readonly string[];
  readonly stderr: string;
  readonly exitCode: number;
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  readonly stderr = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
  };
  constructor(opts: FakeChildOptions) {
    super();
    this.stdout.setEncoding = () => undefined;
    this.stderr.setEncoding = () => undefined;
    queueMicrotask(() => {
      for (const line of opts.stdoutLines) {
        this.stdout.emit("data", `${line}\n`);
      }
      if (opts.stderr.length > 0) {
        this.stderr.emit("data", opts.stderr);
      }
      this.emit("close", opts.exitCode, null);
    });
  }
  kill(): void {
    // Not exercised on this path: the terminal ok line resolves the
    // controller's call before anything would need to kill the child.
  }
}

let spawnImpl: ((cmd: string, args: readonly string[]) => FakeChild) | null =
  null;

vi.mock("node:child_process", () => {
  const spawn = (cmd: string, args: readonly string[]): FakeChild => {
    if (spawnImpl === null) {
      throw new Error("spawn not configured for this test");
    }
    return spawnImpl(cmd, args);
  };
  return { spawn, default: { spawn } };
});

import {
  DESKTOP_LOCK_POLL_INTERVAL_MS,
  DESKTOP_LOCK_WAIT_MS,
  HostController,
  type HostControllerHostLifecycle,
} from "../host-controller";
import { __resetHostRemovalStateForTest } from "../host-removal-state";
import { hostManagesHostLoginItem } from "../../app/host-login-item";
import { prereleaseUpdatesEnabled } from "../../app/update-preferences";
import { waitForHostReady } from "../host-readiness";
import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(
    join(tmpdir(), "traycer-host-controller-ensure-exit-code-"),
  );
  sandboxHome(workHome);
  mkdirSync(join(workHome, ".traycer", "cli"), { recursive: true });
  __resetHostRemovalStateForTest();
  spawnImpl = null;
  vi.mocked(hostManagesHostLoginItem).mockResolvedValue(false);
  vi.mocked(prereleaseUpdatesEnabled).mockReturnValue(false);
  vi.mocked(waitForHostReady).mockResolvedValue({
    ready: true,
    version: "1.0.0",
    pid: 1,
    startedAt: "2026-01-01T00:00:00.000Z",
    reason: "ready",
  });
  vi.mocked(probeHostActivityBusy).mockResolvedValue(false);
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
  spawnImpl = null;
  vi.clearAllMocks();
});

function fakeHostLifecycle(): HostControllerHostLifecycle {
  return {
    notifyRespawning: () => {},
    ensureWatcherInstalled: vi.fn(),
    reloadSnapshotFromDisk: vi.fn(async () => ({
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:55555/rpc",
      version: "1.0.0",
      pid: process.pid,
      systemHostName: "test-host",
      displayName: "Test Host",
      availability: "available",
    })),
  };
}

function newController(): HostController {
  return new HostController({
    environment: "production",
    hostLifecycle: fakeHostLifecycle(),
    reachabilityProbe: async () => true,
    desktopLockWaitMs: DESKTOP_LOCK_WAIT_MS,
    desktopLockPollIntervalMs: DESKTOP_LOCK_POLL_INTERVAL_MS,
  });
}

describe("convergeReadyCliOwned postSwapError mapping survives a real non-zero exit (SSH-USERDOMAIN-WORKGROUP)", () => {
  it("reports the service-start failure when `host ensure`'s terminal ok envelope is followed by exit code 1", async () => {
    const terminalLine = JSON.stringify({
      type: "result",
      status: "ok",
      data: {
        installed: true,
        registered: true,
        running: false,
        version: "1.8.0",
        runtimeVersion: "1.8.0",
        action: "started",
        installGeneration: "gen-1.8.0",
        postSwapError: "boom",
      },
      timestamp: "2026-05-15T00:00:00Z",
    });
    spawnImpl = () =>
      new FakeChild({
        stdoutLines: [terminalLine],
        stderr: "",
        // The exit-code half of the fix under test: `host ensure` now
        // returns exitCode 1 whenever `postSwapError !== null`, even though
        // its JSON payload is a fully-formed `ok` envelope.
        exitCode: 1,
      });

    const controller = newController();
    const outcome = await controller.convergeReady(
      false,
      { kind: "background" },
      "keep-installed",
    );

    // Had the streaming runner tested the exit code before `sawTerminalOk`
    // (S6's mutation), this would instead reject through the "exited with
    // code 1" branch and the message below would never appear. Had
    // `convergeReadyCliOwned` lost the Fixup B7 `postSwapError` check (S7's
    // mutation), this outcome is STILL `kind: "failed"` - but for an
    // unrelated reason (the fixture's `waitForHostReady` mock resolves
    // version "1.0.0" against the expected "1.8.0", so
    // `confirmActivationReadiness`'s own CAS mismatch fires instead) - which
    // is exactly why this assertion pins the MESSAGE, not just `outcome.kind`:
    // ablating S7 measurably proved that a `kind`-only assertion cannot tell
    // the two apart (host-controller.test.ts's "fixup B7" test pins the
    // message for the same reason).
    expect(outcome).toEqual({
      kind: "failed",
      message: expect.stringContaining(
        "background service failed to start after the swap: boom",
      ),
    });
  });
});
