import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wellKnownCliBinaryPath } from "../../store/well-known-cli";
import { runDoctor } from "../engine";
import { DOCTOR_ISSUE_CODES, type DoctorIssue } from "../issues";

// The 1.5.2 rc.2 pass measured `host status`, `host restart` and `host install
// --from` on a Homebrew CLI at 1.0.0 that came first on PATH, and filed what
// that old build did as findings against the release. Nothing on that machine
// said which CLI a bare `traycer` was. The doctor says so, and these run it for
// real: the engine, a PATH made of real directories, and small executables
// standing in for each CLI, each leaving a mark when it is run.
//
// POSIX only: the stand-ins are shell scripts.

const ENVIRONMENT = "production";
const managedBinary = wellKnownCliBinaryPath(ENVIRONMENT);

let dir: string;

function placeCli(path: string, version: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    // An absolute `touch`: these run under the fake PATH.
    `#!/bin/sh\n/usr/bin/touch "${path}.ran"\nprintf '%s\\n' '${version}'\n`,
  );
  chmodSync(path, 0o755);
}

function placeScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n/usr/bin/touch "$0.ran"\n${body}\n`, {
    mode: 0o755,
  });
}

function ran(path: string): boolean {
  return existsSync(`${path}.ran`);
}

async function pathIssue(path: string): Promise<DoctorIssue | undefined> {
  vi.stubEnv("PATH", path);
  const { issues } = await runDoctor({
    environment: ENVIRONMENT,
    portConflictDeps: null,
  });
  return issues.find(
    (issue) => issue.code === DOCTOR_ISSUE_CODES.CLI_SHADOWED_ON_PATH,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "traycer-doctor-path-"));
  placeCli(managedBinary, "1.5.2-rc.2");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(managedBinary, { force: true });
  rmSync(`${managedBinary}.ran`, { force: true });
});

describe.skipIf(process.platform === "win32")("doctor, CLI on PATH", () => {
  // The probe reads a failed spawn as "version unknown", which is what the
  // silent rows expect and the reporting rows see as a missing issue. A machine
  // that cannot run the stand-ins at all fails here, by name.
  beforeEach(() => {
    execFileSync(managedBinary, ["--version"]);
    rmSync(`${managedBinary}.ran`);
  });

  it("names a stale Homebrew CLI ahead of the managed one and the way out", async () => {
    const cellarBinary = join(dir, "Cellar/traycer/1.0.0/bin/traycer");
    const linkDir = join(dir, "homebrew/bin");
    placeCli(cellarBinary, "1.0.0");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(cellarBinary, join(linkDir, "traycer"));
    const brewBinary = join(linkDir, "traycer");

    const issue = await pathIssue(`${linkDir}:${dirname(managedBinary)}`);

    expect(issue).toEqual({
      code: DOCTOR_ISSUE_CODES.CLI_SHADOWED_ON_PATH,
      severity: "warning",
      title: "Another Traycer CLI comes first on PATH",
      message: `'traycer' runs ${brewBinary} (1.0.0), not the CLI Traycer installed at ${managedBinary} (1.5.2-rc.2). Run 'brew upgrade traycer', or put ${dirname(managedBinary)} first on PATH.`,
      fixAction: null,
      terminalCommand: null,
      details: {
        pathBinary: brewBinary,
        pathVersion: "1.0.0",
        managedBinary,
        managedVersion: "1.5.2-rc.2",
      },
    });
  });

  it("names a staging CLI the same way, without Homebrew's way out", async () => {
    const staging = join(dir, "cli/staging/bin/traycer");
    placeCli(staging, "1.5.2-staging.181.g0e77910");

    const issue = await pathIssue(`${dirname(staging)}:/usr/bin`);

    expect(issue?.message).toBe(
      `'traycer' runs ${staging} (1.5.2-staging.181.g0e77910), not the CLI Traycer installed at ${managedBinary} (1.5.2-rc.2). Put ${dirname(managedBinary)} first on PATH.`,
    );
  });

  it("is the first executable that counts, not the first file with the name", async () => {
    const underRelativeEntry = join(dir, "relative/traycer");
    const notExecutable = join(dir, "first/traycer");
    const directory = join(dir, "second/traycer");
    const realFirst = join(dir, "third/traycer");
    placeCli(underRelativeEntry, "1.0.1");
    mkdirSync(dirname(notExecutable), { recursive: true });
    writeFileSync(notExecutable, "");
    mkdirSync(directory, { recursive: true });
    placeCli(realFirst, "1.0.0");

    const relativeEntry = relative(process.cwd(), dirname(underRelativeEntry));

    const issue = await pathIssue(
      `${relativeEntry}:${dir}/first:${dir}/second:${dir}/third`,
    );

    expect(issue?.details).toMatchObject({ pathBinary: realFirst });
  });

  it("stays silent, and runs nothing, when PATH leads to the managed CLI", async () => {
    const linkDir = join(dir, "bin");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(managedBinary, join(linkDir, "traycer"));

    expect(await pathIssue(linkDir)).toBeUndefined();
    expect(ran(managedBinary)).toBe(false);
  });

  it("stays silent, and runs nothing, with no managed CLI to compare against", async () => {
    rmSync(managedBinary);
    const other = join(dir, "bin/traycer");
    placeCli(other, "1.0.0");

    expect(await pathIssue(dirname(other))).toBeUndefined();
    expect(ran(other)).toBe(false);
  });

  it("stays silent with no traycer on PATH", async () => {
    expect(await pathIssue(join(dir, "empty"))).toBeUndefined();
    expect(ran(managedBinary)).toBe(false);
  });

  it("stays silent for the same version at another path", async () => {
    const other = join(dir, "bin/traycer");
    placeCli(other, "1.5.2-rc.2");

    expect(await pathIssue(dirname(other))).toBeUndefined();
    expect(ran(other)).toBe(true);
  });

  it("offers only PATH order for an older CLI Homebrew did not install", async () => {
    const other = join(dir, "local/bin/traycer");
    placeCli(other, "1.0.0");

    const issue = await pathIssue(dirname(other));

    expect(issue?.message).toBe(
      `'traycer' runs ${other} (1.0.0), not the CLI Traycer installed at ${managedBinary} (1.5.2-rc.2). Put ${dirname(managedBinary)} first on PATH.`,
    );
  });

  it("offers only PATH order when the Homebrew CLI is the newer one", async () => {
    const cellarBinary = join(dir, "Cellar/traycer/1.6.0/bin/traycer");
    placeCli(cellarBinary, "1.6.0");

    const issue = await pathIssue(dirname(cellarBinary));

    expect(issue?.message).toBe(
      `'traycer' runs ${cellarBinary} (1.6.0), not the CLI Traycer installed at ${managedBinary} (1.5.2-rc.2). Put ${dirname(managedBinary)} first on PATH.`,
    );
  });

  // Each leaves the mark: a row that never ran would be as silent.
  it.each([
    ["exits non-zero", "exit 1"],
    ["prints nothing", "exit 0"],
    ["prints more than a version", "echo 'one\ntwo'"],
    ["prints a version with a space", "echo '1.0.0 beta'"],
    ["prints a token over 64 characters", `echo '${"1".repeat(65)}'`],
  ])("stays silent when the binary on PATH %s", async (_name, body: string) => {
    const other = join(dir, "bin/traycer");
    placeScript(other, body);

    expect(await pathIssue(dirname(other))).toBeUndefined();
    expect(ran(other)).toBe(true);
  });

  // The row's own timeout is the witness: the stand-in outlives it unless the
  // probe gives up at its deadline.
  it("gives up on a binary that ignores the timeout", async () => {
    const other = join(dir, "bin/traycer");
    // `exec`, so the kill leaves no sleeper behind.
    placeScript(other, "trap '' TERM\nexec /bin/sleep 30");

    expect(await pathIssue(dirname(other))).toBeUndefined();
    expect(ran(other)).toBe(true);
  }, 8_000);

  it("stays silent when the managed CLI cannot name its version", async () => {
    placeScript(managedBinary, "exit 1");
    const other = join(dir, "bin/traycer");
    placeCli(other, "1.0.0");

    expect(await pathIssue(dirname(other))).toBeUndefined();
    expect(ran(managedBinary)).toBe(true);
  });

  it.each([
    ["a list", ".EXE;.CMD"],
    ["an empty member", ";.EXE"],
    ["nothing set", undefined],
  ])(
    "finds a Windows binary through PATHEXT with %s",
    async (_name, pathExt) => {
      const realPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "win32" });
      const winManaged = wellKnownCliBinaryPath(ENVIRONMENT);
      placeCli(winManaged, "1.5.2-rc.2");
      const other = join(dir, "bin/traycer.exe");
      placeCli(other, "1.0.0");
      // Windows would not run this one, whatever PATHEXT holds.
      placeCli(join(dir, "bin/traycer"), "0.0.1");
      vi.stubEnv("PATHEXT", pathExt);

      try {
        const issue = await pathIssue(dirname(other));

        expect(issue?.details).toMatchObject({ pathBinary: other });
      } finally {
        Object.defineProperty(process, "platform", { value: realPlatform });
        rmSync(winManaged, { force: true });
        rmSync(`${winManaged}.ran`, { force: true });
      }
    },
  );
});
