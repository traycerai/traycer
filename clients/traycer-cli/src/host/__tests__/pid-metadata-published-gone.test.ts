import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isProcessAlive } from "../../store/cli-lock";
import { ownProcessStartIdentity } from "../../store/process-identity";
import {
  publishedHostProcessGone,
  type HostPidMetadata,
} from "../pid-metadata";

// `publishedHostProcessGone` against real processes: this one (alive, with
// its own creation stamp), a reaped child (dead), and this pid under a
// stamp no process has (the recycled-pid impostor). Every inconclusive
// input - no stamp, a malformed one, one from another platform - keeps the
// record, because "gone" is positive evidence only.

function record(fields: {
  readonly pid: number;
  readonly processStartIdentity: string | null;
}): HostPidMetadata {
  return {
    pid: fields.pid,
    hostId: "host-1",
    version: "1.0.0",
    websocketUrl: "ws://127.0.0.1:7100/rpc",
    startedAt: "2026-09-06T22:00:00.000Z",
    processStartIdentity: fields.processStartIdentity,
    layer0: null,
    layer0Slot: null,
  };
}

function findDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ["-e", "0"]);
    if (result.pid !== undefined && !isProcessAlive(result.pid)) {
      return result.pid;
    }
  }
  throw new Error("could not obtain a dead pid");
}

const OWN_STAMP = ownProcessStartIdentity();

describe("publishedHostProcessGone", () => {
  it("a pid that no longer runs is gone, stamp or not", () => {
    expect(
      publishedHostProcessGone(
        record({ pid: findDeadPid(), processStartIdentity: null }),
      ),
    ).toBe(true);
  });

  it("a live pid with no stamp on record is not proven gone", () => {
    expect(
      publishedHostProcessGone(
        record({ pid: process.pid, processStartIdentity: null }),
      ),
    ).toBe(false);
  });

  it("a live pid with a malformed stamp on record is judged by the pid alone", () => {
    expect(
      publishedHostProcessGone(
        record({ pid: process.pid, processStartIdentity: "not a token" }),
      ),
    ).toBe(false);
  });

  describe.skipIf(OWN_STAMP === null)("with a creation stamp", () => {
    const own = OWN_STAMP ?? "";
    const tag = own.slice(0, own.indexOf(":"));

    it("a live pid whose stamp matches the record is the publisher", () => {
      expect(
        publishedHostProcessGone(
          record({ pid: process.pid, processStartIdentity: own }),
        ),
      ).toBe(false);
    });

    it("a live pid whose stamp differs from the record is a recycled pid - gone", () => {
      expect(
        publishedHostProcessGone(
          record({
            pid: process.pid,
            processStartIdentity: `${tag}:not the publisher of this record 1`,
          }),
        ),
      ).toBe(true);
    });

    it("a stamp from another platform compares unknown, never different", () => {
      const foreign =
        tag === "linux" ? "darwin:Sun Jul 6 12:00:00 2026" : "linux:boot:1";
      expect(
        publishedHostProcessGone(
          record({ pid: process.pid, processStartIdentity: foreign }),
        ),
      ).toBe(false);
    });
  });
});
