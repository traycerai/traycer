import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// Only the HTTP check is replaced - its two outcomes here are the ones the
// real probe produces for a loopback endpoint (a refused connection folded
// into `true`, an explicit `{busy:false}` as `false`), and standing in for it
// is what lets a test name an endpoint without binding a port to it. The
// liveness gate under test runs the real, unmocked kernel reads.
vi.mock(
  "@traycer-clients/shared/host-client/host-activity-probe",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-activity-probe")
      >();
    return { ...actual, probeHostActivityBusy: vi.fn() };
  },
);

import { probeHostActivityBusy } from "@traycer-clients/shared/host-client/host-activity-probe";
import { readProcessStartIdentity } from "@traycer-clients/shared/host-lock/process-identity";
import { getHostFsLayout } from "../host-paths";
import { probeHostBusyVerdict } from "../host-state";
import { exitedChildPid, liveChild } from "./child-pid-test-support";

let workHome: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-busy-verdict-"));
  sandboxHome(workHome);
  vi.mocked(probeHostActivityBusy).mockReset();
});

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  rmSync(workHome, { recursive: true, force: true });
});

const WEBSOCKET_URL = "ws://127.0.0.1:43210/rpc";

function writePidMetadata(
  pid: number,
  processStartIdentity: string | null,
): void {
  const layout = getHostFsLayout("production");
  mkdirSync(dirname(layout.pidMetadataFile), { recursive: true });
  writeFileSync(
    layout.pidMetadataFile,
    JSON.stringify({
      hostId: "host-1",
      websocketUrl: WEBSOCKET_URL,
      version: "1.7.0",
      pid,
      startedAt: "2026-01-01T00:00:00.000Z",
      ...(processStartIdentity === null ? {} : { processStartIdentity }),
    }),
  );
}

/**
 * A well-formed creation stamp for THIS platform that no process can have.
 * The tag has to be the running platform's or the comparison is `unknown`
 * however the payloads differ - which is the reading a record that travelled
 * between machines must get, and the wrong one for proving a mismatch fires.
 */
function foreignStartIdentityForThisPlatform(): string {
  return `${process.platform}:not-the-stamp-of-any-live-process`;
}

/**
 * A live process's own stamp, read the way a host reads its own before
 * publishing it into `pid.json`. Throws rather than let a platform read that
 * answered nothing degrade a matching-stamp row into the no-stamp one.
 */
function startIdentityOf(pid: number): string {
  const identity = readProcessStartIdentity(pid);
  if (identity === null) {
    throw new Error(`no creation stamp readable for pid ${String(pid)}`);
  }
  return identity;
}

// `probeHostBusyVerdict`: "may this host be torn down?" for the desktop-held
// lock sections around a packaged-macOS SMAppService cycle. A pid.json whose
// publisher is provably gone - a force-killed host leaves exactly that - is no
// host at all, and must not be dialed: its endpoint refuses the connection,
// which `probeHostActivityBusy` folds into `busy` by design, and a cycle that
// reads busy here never reaches the registration that would start a host.
describe("probeHostBusyVerdict", () => {
  it("is no-host for a record whose process has exited, and asks its endpoint nothing", async () => {
    writePidMetadata(await exitedChildPid(), null);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("no-host");
    expect(probeHostActivityBusy).not.toHaveBeenCalled();
  });

  it("is no-host for a LIVE pid the record's creation stamp does not name - a recycled pid is not our host", async () => {
    const child = liveChild();
    cleanups.push(child.stop);
    writePidMetadata(child.pid, foreignStartIdentityForThisPlatform());

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("no-host");
    expect(probeHostActivityBusy).not.toHaveBeenCalled();
  });

  it("dials the endpoint for a LIVE pid the record's creation stamp does name", async () => {
    const child = liveChild();
    cleanups.push(child.stop);
    writePidMetadata(child.pid, startIdentityOf(child.pid));
    vi.mocked(probeHostActivityBusy).mockResolvedValue(false);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("idle");
    expect(probeHostActivityBusy).toHaveBeenCalledWith(WEBSOCKET_URL);
  });

  it("is busy for a LIVE pid whose recorded stamp is not a stamp at all - an unreadable claim is not a mismatch", async () => {
    const child = liveChild();
    cleanups.push(child.stop);
    writePidMetadata(child.pid, "whatever the host wrote here");
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("busy");
  });

  it("is busy for a LIVE process whose endpoint cannot be probed - the fail-safe", async () => {
    writePidMetadata(process.pid, null);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("busy");
  });

  it("is idle for a LIVE process whose host reports no work in progress", async () => {
    writePidMetadata(process.pid, null);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(false);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("idle");
  });
});
