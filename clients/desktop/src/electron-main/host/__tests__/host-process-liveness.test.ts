import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPublishedHostProcessLiveness } from "../host-process-liveness";
import {
  __setAsyncProcessLivenessReaderForTest,
  __setAsyncProcessStartIdentityReaderForTest,
} from "../process-identity";

const HOST_PID = 4242;
const PUBLISHED_AT = "2026-07-25T10:00:00.000Z";
// Tokens are only ever compared against each other, so a fixed platform tag
// keeps these rows identical on a macOS laptop and a Linux runner.
const HOST_IDENTITY = "linux:boot-a 4242";
const STRANGER_IDENTITY = "linux:boot-a 999999";

describe("readPublishedHostProcessLiveness", () => {
  let dir: string;
  let pidFile: string;
  // These seams are process-GLOBAL and test files share a fork, so restore
  // whatever was installed before rather than resetting to the real probes -
  // `null` would reset to the real OS calls and change behaviour for any other
  // suite in this fork, which is a different kind of leak.
  let previousLiveness: Parameters<
    typeof __setAsyncProcessLivenessReaderForTest
  >[0] = null;
  let previousStartIdentity: Parameters<
    typeof __setAsyncProcessStartIdentityReaderForTest
  >[0] = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "host-liveness-"));
    pidFile = join(dir, "pid.json");
  });

  afterEach(() => {
    __setAsyncProcessLivenessReaderForTest(previousLiveness);
    __setAsyncProcessStartIdentityReaderForTest(previousStartIdentity);
    rmSync(dir, { recursive: true, force: true });
  });

  function publishPid(startIdentity: string | null): void {
    writeFileSync(
      pidFile,
      JSON.stringify({
        pid: HOST_PID,
        hostId: "host-1",
        version: "1.1.8",
        websocketUrl: "ws://127.0.0.1:55555/rpc",
        startedAt: PUBLISHED_AT,
        // `null` reproduces a pid.json written before the field existed.
        ...(startIdentity === null
          ? {}
          : { processStartIdentity: startIdentity }),
      }),
      "utf8",
    );
  }

  function stubProcess(
    liveness: "alive" | "dead" | "indeterminate",
    observedIdentity: string | null,
  ): void {
    previousLiveness = __setAsyncProcessLivenessReaderForTest(() =>
      Promise.resolve(liveness),
    );
    previousStartIdentity = __setAsyncProcessStartIdentityReaderForTest(() =>
      Promise.resolve(observedIdentity),
    );
  }

  it("reports a running host as alive - the case that must never be auto-killed", async () => {
    publishPid(HOST_IDENTITY);
    stubProcess("alive", HOST_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("reports a vanished process as dead so recovery can run", async () => {
    publishPid(HOST_IDENTITY);
    stubProcess("dead", null);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "dead",
    );
  });

  it("treats a recycled pid as dead rather than an eternal shield", async () => {
    // Something unrelated now owns this pid: the kernel's creation stamp for
    // whatever is running there is positively not the one the host recorded,
    // so it cannot be the host. Without this, recovery would be blocked
    // forever by a stranger's process.
    publishPid(HOST_IDENTITY);
    stubProcess("alive", STRANGER_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "dead",
    );
  });

  /*
   * traycerai/traycer#740, at the exact seam where it did its damage.
   *
   * A pid.json written by a host that predates `processStartIdentity` gives
   * the verdict nothing to compare. The retired code fell back to comparing a
   * wall-clock-derived start time against the publication timestamp, and a
   * `CLOCK_REALTIME` step - routine on WSL2, which resynchronises when the VM
   * resumes from an idle pause - pushed the derived value past the stamp and
   * produced "mismatch" for a completely healthy host. This function turned
   * that into "dead", which dropped the governor's never-kill shield and let
   * a running host be SIGTERMed every few minutes until the respawn budget
   * ran out and the app wedged.
   *
   * The stub is deliberately the sharpest one available: the process is alive
   * and its observed identity is the host's own. Any reader that reaches for
   * a timestamp fallback has nothing here to make it say "dead" - so this row
   * pins the absence of the fallback, not merely its current answer.
   */
  it("errs towards alive for a legacy pid.json instead of inventing a recycled pid", async () => {
    publishPid(null);
    stubProcess("alive", HOST_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("errs towards alive when the probe cannot conclude", async () => {
    // No identity source (a `/proc` that is not mounted, a refused
    // `Get-Process`). Guessing "dead" here would kill a host that may be
    // working perfectly; guessing "alive" costs at most a wait for the demote
    // window and a manual Retry.
    publishPid(HOST_IDENTITY);
    stubProcess("alive", null);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("errs towards alive when pid.json cannot be read at all", async () => {
    // A partial write, or an EACCES/EIO/EMFILE under memory pressure, leaves
    // the file's fate UNKNOWN - which is why `readPidMetadataState` keeps that
    // apart from ENOENT. Only ENOENT means the host is gone; an inconclusive
    // read must never buy a restart, least of all under the pressure that
    // produces it, when the host is most likely alive and merely stalled.
    writeFileSync(pidFile, '{"pid": 4242, "hostId": "host-1"', "utf8");
    // Sharpest possible stub: anything that reaches the process probe answers
    // "dead", so a regression that falls through instead of short-circuiting
    // fails here rather than passing by luck.
    stubProcess("dead", null);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("reports dead when no pid metadata is published", async () => {
    // A deliberate stop unlinks pid.json, and a host that has not bound yet
    // never published one. Either way there is no process for this gate to
    // protect - the monitor's own metadata check decides what happens next.
    // Stubbed alive-and-matching so only the absent-file short circuit can
    // produce "dead" here.
    stubProcess("alive", HOST_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "dead",
    );
  });
});
