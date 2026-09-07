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
    // Something unrelated now owns this pid: the kernel's creation stamp for whatever is running there is positively not the one the host recorded, so it cannot be the host.
    publishPid(HOST_IDENTITY);
    stubProcess("alive", STRANGER_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "dead",
    );
  });

  it("errs towards alive for a legacy pid.json instead of inventing a recycled pid", async () => {
    publishPid(null);
    stubProcess("alive", HOST_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("errs towards alive when the probe cannot conclude", async () => {
    publishPid(HOST_IDENTITY);
    stubProcess("alive", null);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "alive",
    );
  });

  it("errs towards alive when pid.json cannot be read at all", async () => {
    // Only ENOENT means the host is gone; an inconclusive read must never buy a restart, least of all under the pressure that produces it, when the host is most likely alive and merely.
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
    // A deliberate stop unlinks pid.json, and a host that has not bound yet never published one.
    stubProcess("alive", HOST_IDENTITY);

    await expect(readPublishedHostProcessLiveness(pidFile)).resolves.toBe(
      "dead",
    );
  });
});
