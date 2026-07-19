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
// This forces a REAL probe binary (not a mocked error shape) to hang past
// the bound, so it exercises the actual `timeout` wiring on
// `execFileAsync` rather than just our own error-classification logic.
describe.skipIf(process.platform === "win32")(
  "killConflictingPortOwner - bounded probe timeout (Finding 7)",
  () => {
    let binDir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), "traycer-free-port-hang-test-"));
      // Stands in for the real `lsof` - PATH is prepended with `binDir`
      // below so `execFileAsync("lsof", ...)` resolves to this script
      // instead of the system binary. It never exits on its own; only
      // `PORT_PROBE_TIMEOUT_MS`'s SIGTERM ends it.
      const fakeLsof = join(binDir, "lsof");
      writeFileSync(fakeLsof, "#!/bin/sh\nsleep 60\n");
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
        // Bounded, not indefinite: comfortably above PORT_PROBE_TIMEOUT_MS
        // (the real bound that must fire) but far short of the fake
        // lsof's 60s sleep - reverting the `timeout` option on
        // `execFileAsync` would make this assertion (and the whole test,
        // via its own timeout below) fail instead of silently hanging the
        // suite.
        expect(elapsedMs).toBeGreaterThanOrEqual(PORT_PROBE_TIMEOUT_MS);
        expect(elapsedMs).toBeLessThan(PORT_PROBE_TIMEOUT_MS + 10_000);
      },
      PORT_PROBE_TIMEOUT_MS + 15_000,
    );
  },
);
