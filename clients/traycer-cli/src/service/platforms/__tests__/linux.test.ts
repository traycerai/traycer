import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractExecStartTokens } from "@traycer-clients/shared/host-lifecycle";
const pidMetadata = vi.hoisted(() => ({
  metadata: null as { pid: number } | null,
  gone: false,
  goneCalls: 0,
  // When set, `readHostPidMetadata` answers with this instead once the unit
  // has been signalled - the armed manager's replacement host.
  replacement: null as { pid: number } | null,
  signalled: false,
  goneFor: null as number | null,
}));
vi.mock("../../../host/pid-metadata", () => ({
  readHostPidMetadata: async () =>
    pidMetadata.signalled && pidMetadata.replacement !== null
      ? pidMetadata.replacement
      : pidMetadata.metadata,
  publishedHostProcessGone: (m: { pid: number }) => {
    pidMetadata.goneCalls += 1;
    if (pidMetadata.goneFor !== null) return m.pid === pidMetadata.goneFor;
    return pidMetadata.gone;
  },
}));

import {
  buildSystemdUnit,
  createLinuxController,
  setRestartStopGracesForTests,
} from "../linux";
import { CLI_ERROR_CODES } from "../../../runner/errors";
import type { ServiceLabel } from "../../label";
import type { ServiceController } from "../../index";

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

  it("Q13: the shipped unit's restart policy stays outside systemd's start-limit arithmetic", () => {
    // Two numbers the supervisor's design depends on, neither of them stated
    // in the unit, so both are asserted from the emitted artifact.
    //
    // 1. `Restart=on-failure` + `RestartSec=5`, with NO `StartLimitBurst` or
    //    `StartLimitIntervalSec`, so systemd's defaults apply: burst 5 within
    //    a 10s interval. A restart every 5s puts at most two starts in any
    //    window, so the limit never trips and the unit never lands in
    //    `failed`. Cut `RestartSec` below `10 / 5 = 2` seconds and an ordinary
    //    sequence of restarts starts failing the unit outright - which is the
    //    outage this whole area exists to prevent, arriving by arithmetic
    //    rather than by a code change.
    // 2. `Type=simple` with no `TimeoutStartSec`. The supervisor now WAITS on
    //    the attempt lock for up to `SUPERVISOR_ADMISSION_WAIT_MS` before it
    //    spawns anything, and that is only safe while systemd imposes no
    //    start deadline it could cross. `Type=simple` is considered started
    //    as soon as it forks; adding `TimeoutStartSec`, or moving to
    //    `Type=notify`, would make a healthy wait fail the unit.
    const unit = buildSystemdUnit({
      label: labelFor("ai.traycer.host.dev"),
      cli: { command: "/home/test/.traycer/cli/bin/traycer", args: [] },
    });

    expect(unit).toContain("\nRestart=on-failure\n");
    expect(unit).toContain("\nRestartSec=5\n");
    expect(unit).toContain("\nType=simple\n");
    expect(unit).not.toContain("StartLimitBurst");
    expect(unit).not.toContain("StartLimitIntervalSec");
    expect(unit).not.toContain("StartLimitInterval=");
    expect(unit).not.toContain("TimeoutStartSec");

    // The arithmetic itself, read back off the artifact rather than restated:
    // whatever `RestartSec` says must leave the default burst unreachable.
    const restartSec = /\nRestartSec=(\d+)\n/.exec(unit)?.[1];
    expect(restartSec).toBeDefined();
    const SYSTEMD_DEFAULT_START_LIMIT_INTERVAL_S = 10;
    const SYSTEMD_DEFAULT_START_LIMIT_BURST = 5;
    expect(Number(restartSec)).toBeGreaterThan(
      SYSTEMD_DEFAULT_START_LIMIT_INTERVAL_S /
        SYSTEMD_DEFAULT_START_LIMIT_BURST,
    );
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

describe("Q13: stopForRestart signals the unit instead of stopping it", () => {
  function recordingController(): {
    controller: ServiceController;
    commands: string[][];
  } {
    const commands: string[][] = [];
    const controller = createLinuxController(async (command, args) => {
      commands.push([command, ...args]);
      if (args.includes("kill")) pidMetadata.signalled = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    return { controller, commands };
  }

  beforeEach(() => {
    pidMetadata.metadata = null;
    pidMetadata.gone = false;
    pidMetadata.goneCalls = 0;
    pidMetadata.replacement = null;
    pidMetadata.signalled = false;
    pidMetadata.goneFor = null;
    // Production graces are the host's own force-exit watchdog plus a 10s
    // kill window; letting them elapse is what makes the exhausted-ladder
    // case untestable at real timing.
    setRestartStopGracesForTests({ sigtermMs: 20, sigkillMs: 20 });
  });

  afterEach(() => {
    setRestartStopGracesForTests(null);
  });

  it("never issues the manager's stop verb, and never asks the unit whether it is down", async () => {
    // The whole outage in one assertion. `systemctl stop` puts the unit in
    // `inactive`, and `Restart=` does not apply to a unit stopped that way -
    // this file relies on that in `cancelScheduledAutoRestart`, which uses a
    // stop BECAUSE it cancels a scheduled relaunch. So the update's pre-swap
    // stop disarmed the service manager, and the only thing that re-armed it
    // was the CLI that had just promised the restart.
    //
    // `is-active` is pinned absent for the second half of the same fact: with
    // the manager armed the unit never settles to `inactive`, so a
    // confirmation read from unit state would either never complete or answer
    // about a supervisor the manager started, not the host we signalled.
    pidMetadata.metadata = { pid: 4242 };
    pidMetadata.gone = true;
    const { controller, commands } = recordingController();

    await controller.stopForRestart(labelFor("ai.traycer.host.dev"), {
      force: false,
    });

    const flat = commands.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("kill --signal=SIGTERM"))).toBe(true);
    expect(flat.some((c) => /systemctl --user stop\b/.test(c))).toBe(false);
    expect(flat.some((c) => c.includes("is-active"))).toBe(false);
  });

  it("escalates to SIGKILL when the signalled instance is not provably gone, and says so", async () => {
    // The ladder is the SOLE deadline on this path: `systemctl kill` runs no
    // stop job, so `TimeoutStopSec` does not apply and nothing but this
    // escalates. Remove the escalation and a host that ignores SIGTERM is
    // never killed and never confirmed.
    pidMetadata.metadata = { pid: 4242 };
    pidMetadata.gone = false;
    const { controller, commands } = recordingController();

    const stopped = await controller.stopForRestart(
      labelFor("ai.traycer.host.dev"),
      { force: false },
    );

    const flat = commands.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("kill --signal=SIGTERM"))).toBe(true);
    expect(flat.some((c) => c.includes("kill --signal=SIGKILL"))).toBe(true);
    // Not proven gone, so the relaunch must RECYCLE rather than kickstart: a
    // kickstart of an already-running job is treated as satisfied and no-ops,
    // which would leave the host up on the old bytes after a "successful"
    // restart.
    expect(stopped.forcedRecycle).toBe(true);
  });

  it("a host that published no identity is UNPROVABLE, never silently gone", async () => {
    // The Q14 shape: a pre-stamp `pid.json`, or a platform whose identity
    // probe returned nothing. There is no instance to prove anything about,
    // so this must fall to the safe side. A needless recycle costs a restart;
    // a false "gone" activates over a host that is still running.
    pidMetadata.metadata = null;
    const { controller } = recordingController();

    const stopped = await controller.stopForRestart(
      labelFor("ai.traycer.host.dev"),
      { force: false },
    );

    expect(stopped.forcedRecycle).toBe(true);
    // And it did not consult the identity predicate at all - there was
    // nothing to consult it about.
    expect(pidMetadata.goneCalls).toBe(0);
  });

  it("confirms the instance it SIGNALLED, not whatever the armed manager started in its place", async () => {
    // The hazard this design creates, and the reason the confirmation cannot
    // be a fresh read. With the unit left armed, systemd starts a replacement
    // supervisor `RestartSec` after the signal - so by the time the stop is
    // confirming, `pid.json` may already name a DIFFERENT live host. Reading
    // the instance after signalling would ask "is that replacement gone",
    // answer no, escalate SIGKILL at it, and report a forced recycle over a
    // host that came up exactly as intended.
    //
    // The old host (4242) is gone; the replacement (5353) is live.
    pidMetadata.metadata = { pid: 4242 };
    pidMetadata.replacement = { pid: 5353 };
    pidMetadata.goneFor = 4242;
    const { controller, commands } = recordingController();

    const stopped = await controller.stopForRestart(
      labelFor("ai.traycer.host.dev"),
      { force: false },
    );

    // Proven gone from the identity captured BEFORE the signal.
    expect(stopped.forcedRecycle).toBe(false);
    const flat = commands.map((c) => c.join(" "));
    expect(flat.some((c) => c.includes("kill --signal=SIGKILL"))).toBe(false);
  });

  it("the user-facing `host stop` still uses the manager's stop verb - this round does not change that path", async () => {
    // Repointed from a vacuous assertion (cold review B): the absent
    // `TimeoutStopSec` is not a ceiling the update's ladder sits under, since
    // `systemctl kill` runs no stop job. It IS a live dependency of the plain
    // `host stop` path, which keeps `systemctl stop` and therefore keeps
    // depending on systemd's 90s default. Pinning that the two paths diverged
    // is the true proposition.
    const { controller, commands } = recordingController();

    await controller.stop(labelFor("ai.traycer.host.dev"), { force: false });

    const flat = commands.map((c) => c.join(" "));
    expect(flat.some((c) => /systemctl --user stop\b/.test(c))).toBe(true);
    expect(flat.some((c) => c.includes("kill --signal="))).toBe(false);
  });

  it("the post-swap relaunch is a START, which converges with a waiting supervisor instead of racing it", async () => {
    // Convergence, the half that is pinnable here.
    //
    // Leaving the unit armed means the executor is no longer the only thing
    // that can start a host. Two triggers now aim at the same unit: systemd's
    // own `Restart=on-failure` relaunch `RestartSec` after the signal, and
    // this call at the end of the swap. The supervisor systemd starts arrives
    // while the executor still holds the attempt lock and WAITS on it, so at
    // the moment this relaunch runs, the unit's slot is already occupied by a
    // process that intends to launch the host as soon as it is admitted.
    //
    // `start` is what makes that safe: systemd no-ops a start job against an
    // active unit, so the executor's relaunch does not produce a second
    // supervisor beside the waiter - the waiter launches the host, the
    // executor's verify leg sees it, and exactly one host exists throughout.
    //
    // `restart` would tear the waiter down mid-wait and start another one
    // from scratch, throwing away a wait that was about to be admitted and
    // re-entering the loop this round exists to remove. A direct spawn would
    // be worse: a host the manager does not own, beside a supervisor that is
    // still going to launch its own.
    const { controller, commands } = recordingController();

    await controller.relaunchAfterRestart(labelFor("ai.traycer.host.dev"), {
      forcedRecycle: false,
    });

    const flat = commands.map((c) => c.join(" "));
    expect(flat.some((c) => /systemctl --user start\b/.test(c))).toBe(true);
    expect(flat.some((c) => /systemctl --user restart\b/.test(c))).toBe(false);
    expect(flat.some((c) => c.includes("kill --signal="))).toBe(false);
  });

  it("the Linux relaunch ignores forcedRecycle - the flag is computed for a contract macOS owns", async () => {
    // Stated so it is not mistaken for protection it does not provide.
    // `forcedRecycle` has exactly one consumer, `kickstartDesktopAgent` on
    // macOS, which uses it to choose `kickstart -k` over a plain `kickstart`
    // that would silently no-op. Linux and Windows both route
    // `relaunchAfterRestart` to `startService` and never read it.
    //
    // So the inverted default this round introduced is INERT on Linux today.
    // It is still computed honestly rather than hard-coded, because
    // `RestartStop` is the cross-platform contract and this is the one field
    // whose entire purpose is naming "we could not tell" - a Linux `false`
    // would be a lie in it, inert until the day something reads it
    // generically. Windows hard-codes `false` and says why; Linux cannot,
    // because its stop genuinely may fail to prove the instance gone.
    const { controller, commands } = recordingController();

    await controller.relaunchAfterRestart(labelFor("ai.traycer.host.dev"), {
      forcedRecycle: true,
    });

    expect(commands.map((c) => c.join(" "))).toEqual(
      (
        await (async () => {
          const second = recordingController();
          await second.controller.relaunchAfterRestart(
            labelFor("ai.traycer.host.dev"),
            { forcedRecycle: false },
          );
          return second.commands;
        })()
      ).map((c) => c.join(" ")),
    );
  });
});
