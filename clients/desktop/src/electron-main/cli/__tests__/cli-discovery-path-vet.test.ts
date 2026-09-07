import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_INVOCATION_PROBE_TIMEOUT_MS,
  CLI_RECONCILE_PROBE_TIMEOUT_MS,
  resetCliProbeCacheForTests,
  vetPathCliCandidate,
} from "../cli-discovery";

describe.skipIf(process.platform === "win32")("vetPathCliCandidate", () => {
  const tempDirs: string[] = [];

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "traycer-cli-vet-"));
    tempDirs.push(dir);
    return dir;
  }

  async function writeScript(path: string, body: string): Promise<void> {
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  afterEach(async () => {
    resetCliProbeCacheForTests();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("returns the probed version for a candidate that answers --version", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    await writeScript(candidate, "printf '1.2.3\\n'");
    const vetted = await vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    expect(vetted).toEqual({ version: "1.2.3" });
  });

  it("rejects a candidate that exits 0 with non-version output (the #872 imposter shape)", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    // The imposter desktop relaunch logs two console lines and quits 0
    // (single-instance lock) - exit code alone cannot discriminate it.
    await writeScript(
      candidate,
      "printf '[desktop] logger initialised\\n[desktop] single-instance lock unavailable - quitting\\n'",
    );
    expect(
      await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS),
    ).toBeNull();
  });

  it("rejects a candidate that exits non-zero", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    await writeScript(candidate, "exit 1");
    expect(
      await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS),
    ).toBeNull();
  });

  it("caches the probe verdict per binary path for the process lifetime", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(candidate, `echo x >> '${countFile}'\nprintf '1.2.3\\n'`);
    const execCount = async (): Promise<number> =>
      (await readFile(countFile, "utf8")).split("\n").filter((line) => {
        return line.length > 0;
      }).length;

    await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS);
    await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS);
    expect(await execCount()).toBe(1);

    resetCliProbeCacheForTests();
    await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS);
    expect(await execCount()).toBe(2);
  });

  it("caches a NEGATIVE verdict too (an unresponsive imposter is probed once, not per status poll)", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(candidate, `echo x >> '${countFile}'\nexit 1`);

    expect(
      await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS),
    ).toBeNull();
    expect(
      await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS),
    ).toBeNull();
    const count = (await readFile(countFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0).length;
    expect(count).toBe(1);
  });

  it("tags a candidate inside the npm package as npm-sourced", async () => {
    const dir = await makeTempDir();
    const packageDir = join(dir, "node_modules", "@traycerai", "cli");
    await mkdir(packageDir, { recursive: true });
    const candidate = join(packageDir, "traycer");
    await writeScript(candidate, "printf '1.2.3\\n'");
    const vetted = await vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    expect(vetted).toEqual({ version: "1.2.3", source: "npm" });
  });

  it("a timed-out probe is not cached - the next vet re-probes", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(
      candidate,
      `echo x >> '${countFile}'\nsleep 3\nprintf '1.2.3\\n'`,
    );

    const first = await vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    expect(first).toBeNull();

    const second = await vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    expect(second).toBeNull();
    const count = (await readFile(countFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0).length;
    expect(count).toBe(2);
  }, 10_000);

  // "a not-a-cli verdict IS cached" is already pinned above by "caches a NEGATIVE verdict too (an unresponsive imposter is probed once, not per status poll)".

  // The same fixture that the impatient deadline condemns must vet CLEAN at the reconcile's.
  it("the patient deadline vets a slow-but-real CLI the impatient one drops", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    await writeScript(candidate, "sleep 3\nprintf '1.2.3\\n'");

    // Positive control: the same binary, the same code path, 2s deadline.
    // Without it a green below could equally mean "the fixture is fast now".
    expect(
      await vetPathCliCandidate(candidate, CLI_INVOCATION_PROBE_TIMEOUT_MS),
    ).toBeNull();

    expect(
      await vetPathCliCandidate(candidate, CLI_RECONCILE_PROBE_TIMEOUT_MS),
    ).toEqual({ version: "1.2.3" });
  }, 20_000);

  // It must get a probe that can actually run for 15s.
  it("a patient caller does not inherit a shorter in-flight deadline", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(
      candidate,
      `echo x >> '${countFile}'\nsleep 3\nprintf '1.2.3\\n'`,
    );

    const impatient = vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    const patient = await vetPathCliCandidate(
      candidate,
      CLI_RECONCILE_PROBE_TIMEOUT_MS,
    );

    // Inheriting the 2s probe would make this null - the fixture needs 3s.
    expect(patient).toEqual({ version: "1.2.3" });
    // The impatient caller still gets its own (correct, impatient) answer.
    expect(await impatient).toBeNull();
    // Two spawns, necessarily: the deadlines cannot share one process.
    const count = (await readFile(countFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0).length;
    expect(count).toBe(2);
  }, 20_000);

  // Patience must not leak onto the impatient path.
  // Started patient, joined impatient: the joiner must give up on its own schedule, well before the fixture answers.
  it("an impatient joiner does not inherit an in-flight patient deadline", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    // Six seconds, not three: the margin between "raced at its own 2s" and
    // "waited for the patient probe" has to survive a loaded CI runner
    // without the assertion below going flaky in either direction.
    await writeScript(candidate, "sleep 6\nprintf '1.2.3\\n'");

    const patient = vetPathCliCandidate(
      candidate,
      CLI_RECONCILE_PROBE_TIMEOUT_MS,
    );
    const startedAt = Date.now();
    const joined = await vetPathCliCandidate(
      candidate,
      CLI_INVOCATION_PROBE_TIMEOUT_MS,
    );
    const waitedMs = Date.now() - startedAt;

    expect(joined).toBeNull();
    expect(waitedMs).toBeLessThan(4_000);
    // ...and the patient probe it joined still lands its real verdict.
    expect(await patient).toEqual({ version: "1.2.3" });
  }, 20_000);
});
