import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";

// `host-state.ts` also imports `probeHostActivityBusy` from this module; the
// real one is kept, only the reader the quit takes is replaced.
vi.mock(
  "@traycer-clients/shared/host-client/host-activity-probe",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-activity-probe")
      >();
    return { ...actual, probeHostActivity: vi.fn() };
  },
);

import { probeHostActivity } from "@traycer-clients/shared/host-client/host-activity-probe";
import { getHostFsLayout } from "../host-paths";
import { probeLocalHostActivity } from "../host-state";

// `probeLocalHostActivity`: the local host's `GET /activity` answer for a quit
// under "Stop if idle". Nothing on disk to ask is `unreachable`, the same
// answer as nothing answering - never a count, never an error.

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-local-activity-probe-"));
  sandboxHome(workHome);
  vi.mocked(probeHostActivity).mockReset();
});

afterEach(() => {
  rmSync(workHome, { recursive: true, force: true });
});

function writePidMetadata(contents: string): void {
  const layout = getHostFsLayout("production");
  mkdirSync(dirname(layout.pidMetadataFile), { recursive: true });
  writeFileSync(layout.pidMetadataFile, contents);
}

describe("probeLocalHostActivity", () => {
  it("is unreachable, and asks nothing, when there is no pid metadata", async () => {
    await expect(
      probeLocalHostActivity(getHostFsLayout("production")),
    ).resolves.toEqual({ kind: "unreachable" });
    expect(probeHostActivity).not.toHaveBeenCalled();
  });

  it("is unreachable when the metadata is not JSON", async () => {
    writePidMetadata("not json");

    await expect(
      probeLocalHostActivity(getHostFsLayout("production")),
    ).resolves.toEqual({ kind: "unreachable" });
    expect(probeHostActivity).not.toHaveBeenCalled();
  });

  it("is unreachable when the metadata carries no websocketUrl string", async () => {
    writePidMetadata(JSON.stringify({ pid: 4242, websocketUrl: 7 }));

    await expect(
      probeLocalHostActivity(getHostFsLayout("production")),
    ).resolves.toEqual({ kind: "unreachable" });
    expect(probeHostActivity).not.toHaveBeenCalled();
  });

  it("asks the host at the recorded websocketUrl and returns its answer as read", async () => {
    writePidMetadata(
      JSON.stringify({ pid: 4242, websocketUrl: "ws://127.0.0.1:43210/rpc" }),
    );
    vi.mocked(probeHostActivity).mockResolvedValue({
      kind: "answered",
      busy: false,
      terminalsInUse: 2,
    });

    await expect(
      probeLocalHostActivity(getHostFsLayout("production")),
    ).resolves.toEqual({ kind: "answered", busy: false, terminalsInUse: 2 });
    expect(probeHostActivity).toHaveBeenCalledTimes(1);
    expect(probeHostActivity).toHaveBeenCalledWith("ws://127.0.0.1:43210/rpc");
  });

  it("passes an unreachable answer through as unreachable", async () => {
    writePidMetadata(
      JSON.stringify({ websocketUrl: "ws://127.0.0.1:43210/rpc" }),
    );
    vi.mocked(probeHostActivity).mockResolvedValue({ kind: "unreachable" });

    await expect(
      probeLocalHostActivity(getHostFsLayout("production")),
    ).resolves.toEqual({ kind: "unreachable" });
  });
});
