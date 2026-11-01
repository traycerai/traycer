import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// Only the HTTP check is replaced - its two outcomes here are the ones the
// real probe produces for a loopback endpoint (a refused connection folded
// into `true`, an explicit `{busy:false}` as `false`), and standing in for it
// is what lets a test name an endpoint without binding a port to it.
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
import { getHostFsLayout } from "../host-paths";
import { probeHostBusyVerdict } from "../host-state";

// `probeHostBusyVerdict`: "may this host be torn down?" for the desktop-held
// lock sections around a packaged-macOS SMAppService cycle. A pid.json whose
// publisher is provably gone - a force-killed host leaves exactly that - is
// no host at all, and must not be dialed: its endpoint refuses the connection,
// which `probeHostActivityBusy` folds into `busy` by design, and a cycle that
// reads busy here never reaches the registration that would start a host.

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-busy-verdict-"));
  sandboxHome(workHome);
  vi.mocked(probeHostActivityBusy).mockReset();
});

afterEach(() => {
  rmSync(workHome, { recursive: true, force: true });
});

function writePidMetadata(pid: number): void {
  const layout = getHostFsLayout("production");
  mkdirSync(dirname(layout.pidMetadataFile), { recursive: true });
  writeFileSync(
    layout.pidMetadataFile,
    JSON.stringify({
      hostId: "host-1",
      websocketUrl: "ws://127.0.0.1:43210/rpc",
      version: "1.7.0",
      pid,
      startedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
}

/**
 * A pid that names no process: a child spawned and waited out, so the kernel
 * has reaped it before the record naming it is read. The liveness gate runs
 * the real, unmocked `process.kill(pid, 0)`, which answers ESRCH for it -
 * a hardcoded "probably free" pid would be a different machine's live process
 * on a bad day.
 */
async function exitedChildPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const { pid } = child;
  if (pid === undefined) throw new Error("spawning a child yielded no pid");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return pid;
}

describe("probeHostBusyVerdict", () => {
  it("is no-host for a record whose process has exited, and asks its endpoint nothing", async () => {
    writePidMetadata(await exitedChildPid());

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("no-host");
    expect(probeHostActivityBusy).not.toHaveBeenCalled();
  });

  it("is busy for a LIVE process whose endpoint cannot be probed - the fail-safe", async () => {
    writePidMetadata(process.pid);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(true);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("busy");
  });

  it("is idle for a LIVE process whose host reports no work in progress", async () => {
    writePidMetadata(process.pid);
    vi.mocked(probeHostActivityBusy).mockResolvedValue(false);

    await expect(
      probeHostBusyVerdict(getHostFsLayout("production")),
    ).resolves.toBe("idle");
    expect(probeHostActivityBusy).toHaveBeenCalledWith(
      "ws://127.0.0.1:43210/rpc",
    );
  });
});
