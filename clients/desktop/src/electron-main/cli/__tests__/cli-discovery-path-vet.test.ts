import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetCliProbeCacheForTests,
  vetPathCliCandidate,
} from "../cli-discovery";

// PATH-candidate vetting (oss #872). `discoverCli` may only return a PATH
// `traycer` after it answers `--version` - the name can be squatted by
// something that is not our CLI at all (the field case: an AppImage
// manager exposed the DESKTOP APP itself as `traycer`, which exits 0 with
// console noise). These tests exec real fixture scripts through the real
// probe, so they cover the execFile plumbing as well as the verdict.
//
// POSIX-only: the fixtures are `#!/bin/sh` scripts, and the desktop test
// suite runs on POSIX CI.
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
    const vetted = await vetPathCliCandidate(candidate);
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
    expect(await vetPathCliCandidate(candidate)).toBeNull();
  });

  it("rejects a candidate that exits non-zero", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    await writeScript(candidate, "exit 1");
    expect(await vetPathCliCandidate(candidate)).toBeNull();
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

    await vetPathCliCandidate(candidate);
    await vetPathCliCandidate(candidate);
    expect(await execCount()).toBe(1);

    resetCliProbeCacheForTests();
    await vetPathCliCandidate(candidate);
    expect(await execCount()).toBe(2);
  });

  it("caches a NEGATIVE verdict too (an unresponsive imposter is probed once, not per status poll)", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(candidate, `echo x >> '${countFile}'\nexit 1`);

    expect(await vetPathCliCandidate(candidate)).toBeNull();
    expect(await vetPathCliCandidate(candidate)).toBeNull();
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
    const vetted = await vetPathCliCandidate(candidate);
    expect(vetted).toEqual({ version: "1.2.3", source: "npm" });
  });

  // `probeCliVersion` now returns a discriminated union, and the path-probe
  // cache deliberately drops "timeout" verdicts - a `timeout` describes the
  // probe's PATIENCE, not the binary, and the very slot-refresh that made a
  // real packaged CLI's first `--version` slow is what repairs it for the
  // next one. Caching it would pin a real CLI as unusable for the rest of
  // the desktop session. Driven with a real `sleep`-based fixture past the
  // probe's 2s timeout rather than a mocked `execFile`, so this exercises
  // the actual kill/verdict plumbing - which costs a bit over 2 seconds per
  // spawn. Accepted once, here, as the direct pin for this exact branch.
  it("a timed-out probe is not cached - the next vet re-probes", async () => {
    const dir = await makeTempDir();
    const candidate = join(dir, "traycer");
    const countFile = join(dir, "exec-count");
    await writeScript(
      candidate,
      `echo x >> '${countFile}'\nsleep 3\nprintf '1.2.3\\n'`,
    );

    const first = await vetPathCliCandidate(candidate);
    expect(first).toBeNull();

    // A cached `timeout` verdict would answer this SECOND call from the
    // cache without spawning again. Asserting on the exec count - not
    // just the (identical, null) verdict - is what actually pins the
    // non-caching: a same-verdict-twice check alone cannot distinguish
    // "re-probed and timed out again" from "returned the cached one".
    const second = await vetPathCliCandidate(candidate);
    expect(second).toBeNull();
    const count = (await readFile(countFile, "utf8"))
      .split("\n")
      .filter((line) => line.length > 0).length;
    expect(count).toBe(2);
  }, 10_000);

  // "a not-a-cli verdict IS cached" is already pinned above by "caches a
  // NEGATIVE verdict too (an unresponsive imposter is probed once, not per
  // status poll)" - that test's fixture exits non-zero (the `not-a-cli`
  // verdict) and asserts exactly one exec across two `vetPathCliCandidate`
  // calls, which is this same property under a different name. Not
  // duplicated here.
});
