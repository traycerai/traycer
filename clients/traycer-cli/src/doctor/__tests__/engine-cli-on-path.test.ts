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
      message: `'traycer' runs ${brewBinary} (1.0.0), not the managed CLI at ${managedBinary} (1.5.2-rc.2). Run 'brew upgrade traycer', or put ${dirname(managedBinary)} first on PATH.`,
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
      `'traycer' runs ${staging} (1.5.2-staging.181.g0e77910), not the managed CLI at ${managedBinary} (1.5.2-rc.2). Put ${dirname(managedBinary)} first on PATH.`,
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

  it.each([
    ["exits non-zero", "#!/bin/sh\nexit 1\n"],
    ["prints nothing", "#!/bin/sh\n"],
    ["prints more than a version", "#!/bin/sh\necho 'one\ntwo'\n"],
  ])(
    "stays silent when the binary on PATH %s",
    async (_name, script: string) => {
      const other = join(dir, "bin/traycer");
      mkdirSync(dirname(other), { recursive: true });
      writeFileSync(other, script, { mode: 0o755 });

      expect(await pathIssue(dirname(other))).toBeUndefined();
    },
  );

  it("stays silent when the managed CLI cannot name its version", async () => {
    writeFileSync(managedBinary, "#!/bin/sh\nexit 1\n");
    const other = join(dir, "bin/traycer");
    placeCli(other, "1.0.0");

    expect(await pathIssue(dirname(other))).toBeUndefined();
  });

  it("finds a Windows binary through PATHEXT", async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const winManaged = wellKnownCliBinaryPath(ENVIRONMENT);
    placeCli(winManaged, "1.5.2-rc.2");
    const other = join(dir, "bin/traycer.exe");
    placeCli(other, "1.0.0");
    vi.stubEnv("PATHEXT", ".EXE;.CMD");

    try {
      const issue = await pathIssue(dirname(other));

      expect(issue?.details).toMatchObject({ pathBinary: other });
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform });
      rmSync(winManaged, { force: true });
      rmSync(`${winManaged}.ran`, { force: true });
    }
  });
});
