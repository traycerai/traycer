import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractExecStartTokens } from "@traycer-clients/shared/host-lifecycle";
import { buildSystemdUnit } from "../linux";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { ServiceLabel } from "../../label";

/**
 * The systemd emitter had NO test file at all: `buildUnit` was covered only by
 * `toContain` substring assertions in `commands/__tests__/host-start.test.ts`.
 * That was proven vacuous twice over during cold review -
 *
 *   * dropping one closing quote from the emitted script left all 31 tests
 *     green while `sh -n` on the extracted `ExecStart` reported
 *     "unexpected EOF"; the Linux host would never have started;
 *   * `expect(unit).toContain("--service-label")` passed even with the label
 *     branch stripped, because the string also appeared in the probe.
 *
 * So everything here goes through the emitted artifact the way systemd would:
 * parse `ExecStart=`, recover the token vector, and EXECUTE the resulting
 * program against stub CLIs. Substring assertions appear only where the claim
 * genuinely is about text (the unit-file scaffolding).
 */

const execFileAsync = promisify(execFile);

function labelFor(id: string): ServiceLabel {
  return {
    id,
    displayName: "Traycer Host (test)",
    environment: "dev",
    devSlot: null,
  };
}

/**
 * Recover the argv vector systemd would exec, straight out of the emitted
 * unit. `extractExecStartTokens` is systemd's own quoting/escaping rule as
 * implemented for the world probe, so this exercises the emitter's escaping
 * rather than trusting it.
 */
function execStartOf(unit: string): readonly string[] {
  const tokens = extractExecStartTokens(unit);
  if (tokens === null) throw new Error("unit has no ExecStart= line");
  return tokens;
}

let work = "";

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "traycer-linux-unit-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/**
 * A CLI that predates the capability contract: it has no `host capabilities`
 * subcommand, so commander exits non-zero with a message on stderr. Anything
 * else it is asked to run is recorded, one argument per line.
 */
async function writeLegacyCliStub(recordTo: string): Promise<string> {
  const path = join(work, "legacy-cli.sh");
  await writeFile(
    path,
    `#!/bin/sh
if [ "$1" = "host" ] && [ "$2" = "capabilities" ]; then
  echo "error: unknown command 'capabilities'" >&2
  exit 1
fi
printf '%s\\n' "$@" > ${JSON.stringify(recordTo)}
`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
}

/** A current CLI: answers the capability probe with exit 0 and no output. */
async function writeCurrentCliStub(
  recordTo: string,
  leadingArgs: readonly string[],
): Promise<string> {
  const path = join(work, "current-cli.sh");
  const guard = [
    ...leadingArgs,
    "host",
    "capabilities",
    "--has",
    "service-label",
  ]
    .map((arg, index) => `[ "$${index + 1}" = ${JSON.stringify(arg)} ]`)
    .join(" && ");
  await writeFile(
    path,
    `#!/bin/sh
if ${guard}; then exit 0; fi
printf '%s\\n' "$@" > ${JSON.stringify(recordTo)}
`,
    "utf8",
  );
  await chmod(path, 0o700);
  return path;
}

describe("systemd unit ExecStart — executed, not grepped", () => {
  it("parses as a shell program (`sh -n` on exactly what systemd hands /bin/sh)", async () => {
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    const [shell, dashC, script] = execStartOf(unit);
    expect(shell).toBe("/bin/sh");
    expect(dashC).toBe("-c");
    expect(script).toBeTypeOf("string");

    // `sh -n` parses without executing. This is the check that caught the
    // dropped closing quote every substring assertion sailed past.
    await expect(
      execFileAsync("/bin/sh", ["-n", "-c", script ?? ""]),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("starts an N-1 CLI unlabelled and a current CLI with its label, preserving leading invocation args", async () => {
    const legacyArgs = join(work, "legacy-args.txt");
    const currentArgs = join(work, "current-args.txt");
    const legacyCli = await writeLegacyCliStub(legacyArgs);
    const currentCli = await writeCurrentCliStub(currentArgs, [
      "--entry=cli-entry.js",
    ]);

    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: currentCli, args: ["--entry=cli-entry.js"] },
    });
    const tokens = execStartOf(unit);
    const script = tokens[2] ?? "";

    // systemd execs `/bin/sh -c <script> <cli> <args...>`, which is what
    // makes `"$0"`/`"$@"` inside the script resolve to the CLI invocation.
    await execFileAsync("/bin/sh", ["-c", script, legacyCli]);
    await execFileAsync("/bin/sh", [
      "-c",
      script,
      currentCli,
      "--entry=cli-entry.js",
    ]);

    expect(await readFile(legacyArgs, "utf8")).toBe("host\nstart\n");
    expect(await readFile(currentArgs, "utf8")).toBe(
      "--entry=cli-entry.js\nhost\nstart\n--service-label\nai.traycer.host.dev\n",
    );
  });

  it("the emitted ExecStart token vector round-trips the CLI path and args through systemd's quoting", () => {
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: {
        command: "/home/a user/.traycer/cli/bin/traycer",
        args: ["--entry=cli-entry.js"],
      },
    });
    const tokens = execStartOf(unit);

    expect(tokens[0]).toBe("/bin/sh");
    expect(tokens[1]).toBe("-c");
    // A path with a space must survive as ONE token, not two.
    expect(tokens[3]).toBe("/home/a user/.traycer/cli/bin/traycer");
    expect(tokens[4]).toBe("--entry=cli-entry.js");
    expect(tokens).toHaveLength(5);
  });

  it("a label containing a single quote still emits parseable shell and reaches the CLI verbatim", async () => {
    // F7: `shellQuote` used to emit `'ab'\"'\"'cd'`, which is neither the
    // POSIX `'\''` form nor the `'"'"'` one it was reaching for - `sh` died
    // with "unexpected EOF". Unreachable through today's label alphabet, but
    // it is the guard the emitters lean on, so it has to actually hold.
    const currentArgs = join(work, "quoted-args.txt");
    const currentCli = await writeCurrentCliStub(currentArgs, []);
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.ab'cd"),
      cli: { command: currentCli, args: [] },
    });
    const script = execStartOf(unit)[2] ?? "";

    await expect(
      execFileAsync("/bin/sh", ["-n", "-c", script]),
    ).resolves.toMatchObject({ stderr: "" });
    await execFileAsync("/bin/sh", ["-c", script, currentCli]);

    expect(await readFile(currentArgs, "utf8")).toBe(
      "host\nstart\n--service-label\nai.traycer.host.ab'cd\n",
    );
  });

  it("probes the capability contract, never help text or grep", () => {
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    const script = execStartOf(unit)[2] ?? "";

    expect(script).toContain("host capabilities --has service-label");
    expect(script).not.toContain("--help");
    // `/usr/bin/grep` does not exist on NixOS; the probe must not need it.
    expect(script).not.toContain("grep");
  });

  it("emits no character systemd mis-parses inside the ExecStart value", () => {
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    const line = unit
      .split("\n")
      .find((candidate) => candidate.startsWith("ExecStart="));
    expect(line).toBeDefined();
    // `%` is a specifier introducer and `;` an argument separator; either one
    // inside the value makes systemd read a different program than we wrote.
    expect(line ?? "").not.toMatch(/[%;\t]/);
  });
});

describe("systemd unit — scaffolding and the token guard", () => {
  it("declares the service so a user-session login starts it", () => {
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    expect(unit).toContain("[Service]\nType=simple");
    expect(unit).toContain("\nOOMPolicy=continue\n");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("[Install]\nWantedBy=default.target");
    expect(unit).not.toContain("--environment");
    expect(unit).not.toContain("--bundle");
    expect(unit).not.toContain("--node-bin");
  });

  it("names the journald stream after the label, not the /bin/sh wrapper", () => {
    // journald's default SYSLOG_IDENTIFIER is the basename of the Exec
    // line's first executable - `sh` - and the stdout stream opens BEFORE
    // the wrapper exec's the CLI, so exec never renames it. Without this
    // line every supervisor message the debugging user reads in
    // `journalctl --user -u <unit>` is attributed to `sh[pid]`.
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    expect(unit).toContain("\nSyslogIdentifier=ai.traycer.host.dev\n");
  });

  it("gates the start on the CLI binary existing, so a stranded definition goes inert instead of restart-looping", () => {
    // A definition can outlive the CLI it points at (`apt remove
    // traycer-cli` with the unit still enabled). Without the condition,
    // every login exec's a missing $0 → exit 127 → Restart=on-failure loops
    // it into a `failed` unit on every boot. With it, systemd skips the
    // start as "condition not met": visible in status, not failing, and
    // re-evaluated fresh by the next `systemctl start` after a reinstall.
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });
    expect(unit).toContain(
      "\nConditionFileIsExecutable=/home/test/.traycer/cli/bin/traycer\n",
    );
  });

  it("omits the path condition for a non-absolute CLI command", () => {
    // systemd rejects relative paths in Condition*= values; the self-invoke
    // fallback can in principle yield a bare command, which must degrade to
    // "no condition" rather than an invalid unit.
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "traycer", args: [] },
    });
    expect(unit).not.toContain("ConditionFileIsExecutable");
  });

  it("refuses to emit a unit when a CLI path carries a character systemd would mis-parse", () => {
    expect(() =>
      buildSystemdUnit({
        label: labelFor("ai.traycer.host.dev"),
        cli: { command: "/home/test/100%/traycer", args: [] },
      }),
    ).toThrowError(
      expect.objectContaining({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED }),
    );
  });
});
