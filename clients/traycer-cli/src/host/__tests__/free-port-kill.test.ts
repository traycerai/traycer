import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  killConflictingPortOwner,
  PORT_PROBE_TIMEOUT_MS,
} from "../free-port-kill";

// Finding 7 (ticket-2 review round 1): the `lsof`/`netstat` ownership
// probes now run entirely inside `cli-lock`. Before `PORT_PROBE_TIMEOUT_MS`
// existed, a wedged/hijacked probe binary would hang `execFileAsync`
// forever - the lock holder stays positively alive, so ticket-1's
// hardened stale-lock breaking correctly refuses to break it, and every
// other host mutation wedges until a human kills the process by hand.
// This forces a REAL TERM-ignoring probe binary (not a mocked error shape)
// to hang past the bound, proving the SIGKILL escalation rather than merely
// `execFile`'s soft SIGTERM timeout wiring.
describe.skipIf(process.platform === "win32")(
  "killConflictingPortOwner - bounded probe timeout (Finding 7)",
  () => {
    let binDir: string;
    let fakeLsof: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), "traycer-free-port-hang-test-"));
      // Stands in for the real `lsof` - PATH is prepended with `binDir`
      // below so the probe resolves to this script instead of the system
      // binary. It deliberately ignores SIGTERM, so only the hard SIGKILL
      // escalation can release the CLI lock.
      fakeLsof = join(binDir, "lsof");
      writeFileSync(
        fakeLsof,
        "#!/bin/sh\ntrap '' TERM\nwhile true; do /bin/sleep 1; done\n",
      );
      chmodSync(fakeLsof, 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
    });

    it(
      "settles in bounded time with a structured timeout verdict instead of hanging forever",
      async () => {
        const start = Date.now();
        // `process.pid` (this test process) is guaranteed alive, so the
        // liveness pre-check passes and the hung `lsof` stand-in is what
        // actually gets exercised.
        await expect(
          killConflictingPortOwner({
            pid: process.pid,
            port: 65535,
            commandName: "host free-port",
          }),
        ).rejects.toMatchObject({
          details: { probe: "timeout" },
        });
        const elapsedMs = Date.now() - start;
        // Bounded, not indefinite: the TERM-ignoring fixture proves the
        // SIGKILL escalation settles the promise shortly after the soft
        // deadline, instead of waiting for its infinite loop.
        expect(elapsedMs).toBeGreaterThanOrEqual(PORT_PROBE_TIMEOUT_MS);
        expect(elapsedMs).toBeLessThan(PORT_PROBE_TIMEOUT_MS + 3_000);
      },
      PORT_PROBE_TIMEOUT_MS + 5_000,
    );

    it(
      "kills an unbounded-output probe at the output budget instead of growing memory until the deadline",
      async () => {
        writeFileSync(fakeLsof, "#!/bin/sh\nexec yes x\n");
        const start = Date.now();

        await expect(
          killConflictingPortOwner({
            pid: process.pid,
            port: 65535,
            commandName: "host free-port",
          }),
        ).rejects.toMatchObject({
          details: { probe: "output-overflow" },
        });

        expect(Date.now() - start).toBeLessThan(PORT_PROBE_TIMEOUT_MS);
      },
      PORT_PROBE_TIMEOUT_MS,
    );
  },
);
