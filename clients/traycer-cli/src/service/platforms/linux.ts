import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
import { buildCompatibleHostStartScript } from "./host-start-script";
import { fileExists } from "../install-binary";
import { serviceManifestPath, type ServiceLabel } from "../label";
import { ProcessRunError, runCommand } from "../process-runner";
import type {
  InstallServiceOptions,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";

// Linux service controller - systemd-user. The unit's ExecStart points
// at the per-user CLI binary with `host start` (the slot is baked into
// the CLI build) so an in-place host install never needs a unit-file
// rewrite.
//
// `loginctl enable-linger` is best-effort. The Tech Plan accepts a
// silent skip if polkit would prompt - Doctor surfaces the missing
// linger as a warning so the user can enable it later.

// The pluggable runner seam is live on Linux too: `null` selects the real
// `runCommand`, tests inject a fake to drive the install/uninstall flows
// (preflight, rollback-on-failure) without a systemd instance. Same factory
// signature as macOS/Windows
// (`createMacos|Linux|WindowsController(runner: ProcessRunner | null)`).
export function createLinuxController(
  runner: ProcessRunner | null,
): ServiceController {
  const run = runner ?? runCommand;
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label),
    stop: (label) => stopService(label, run),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run),
    // There is no Desktop/SMAppService split on Linux, so the restart halves
    // are exactly the stop and start the command already performed - the
    // named seam only exists so `host restart` has one shape on every
    // platform. `forcedRecycle` is never set: `stopService` is a real
    // systemd stop, so the unit is genuinely down before the start.
    stopForRestart: async (label) => {
      await stopService(label, run);
      return { forcedRecycle: false };
    },
    relaunchAfterRestart: (label) => startService(label, run),
    // SMAppService is macOS-only, so there is no second registration path
    // that could compete with systemd's user unit here.
    retireCompetingRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
    takeoverDesktopRegistration: () =>
      Promise.resolve({ kind: "not-applicable" }),
  };
}

// Pluggable runner shape kept consistent with macOS so the three
// controllers expose the same factory signature, even when Linux
// doesn't currently use the seam.
export type ProcessRunner = typeof runCommand;

/**
 * Proves the user systemd instance is reachable BEFORE anything is written.
 *
 * `systemctl --user` needs a per-user service manager on a session bus, and
 * that is exactly what does not exist on a WSL distro without systemd
 * enabled, in a `sudo su <user>` shell, or over SSH to a box whose logind
 * never started a user manager. The previous order wrote the unit file
 * first and then let `daemon-reload` throw a raw `ProcessRunError`: an
 * orphan unit file left behind, and a stack trace naming neither systemd
 * nor WSL. Failing here fails with nothing installed and an error that
 * says what to do.
 */
async function assertSystemdUserReachable(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "show-environment"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message:
        `the systemd user manager is not reachable, so the ${unitName(label)} service cannot be installed: ${describeCause(cause)}. ` +
        `If this is WSL, enable systemd ('[boot]' / 'systemd=true' in /etc/wsl.conf, then 'wsl --shutdown' from Windows). ` +
        `On a headless machine, log in through a systemd session first. Nothing was installed.`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function installService(
  options: InstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  await assertSystemdUserReachable(options.label, run);
  const manifestPath = serviceManifestPath(options.label);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    buildUnit({ label: options.label, cli: options.cli }),
    "utf8",
  );
  // daemon-reload picks up the new unit; enable --now both registers
  // the auto-start and starts the unit immediately.
  try {
    await run("systemctl", ["--user", "daemon-reload"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
    await run(
      "systemctl",
      ["--user", "enable", "--now", unitName(options.label)],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 15_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    // Roll the write back: a unit file systemd was never told about (or
    // refused to enable) must not outlive the failed install - it would sit
    // in ~/.config/systemd/user as an orphan that a later daemon-reload
    // silently registers. All cleanup steps are best-effort; the error the
    // operator sees is the install failure, not the rollback's.
    //
    // `enable --now` is enable-then-start as two separate steps: a start
    // failure after a successful enable leaves the enablement symlinks in
    // place (systemd does not roll them back), so `disable` must run BEFORE
    // the manifest is removed - otherwise the surviving symlinks point at a
    // unit file that no longer exists.
    await run(
      "systemctl",
      ["--user", "disable", "--now", unitName(options.label)],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 10_000,
        tolerateNonZeroExit: true,
      },
    ).catch(() => undefined);
    await rm(manifestPath, { force: true }).catch(() => undefined);
    await run("systemctl", ["--user", "daemon-reload"], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: true,
    }).catch(() => undefined);
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `systemd registration failed for ${unitName(options.label)}: ${describeCause(cause)} (the partially-written unit file was removed)`,
      details: { unit: unitName(options.label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
  if (options.enableLinger) {
    await tryEnableLinger(run);
  }
}

async function tryEnableLinger(run: ProcessRunner): Promise<void> {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  if (user.length === 0) return;
  // Tolerate non-zero exit so a polkit prompt or already-enabled state
  // doesn't fail the install. Doctor flags the absence later.
  await run("loginctl", ["enable-linger", user], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
}

async function uninstallService(
  options: UninstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  await run(
    "systemctl",
    ["--user", "disable", "--now", unitName(options.label)],
    {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: true,
    },
  );
  await rm(serviceManifestPath(options.label), { force: true });
  await run("systemctl", ["--user", "daemon-reload"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
  // A unit that ended up `failed` (e.g. it restart-looped before this
  // uninstall) leaves a failed entry in the user manager even after its
  // file is gone; clear it so `systemctl --user list-units` and
  // `is-system-running` stop reporting a service that no longer exists.
  await run("systemctl", ["--user", "reset-failed", unitName(options.label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  }).catch(() => undefined);
}

async function statusService(label: ServiceLabel): Promise<ServiceStatus> {
  const manifestExists = await fileExists(serviceManifestPath(label));
  if (!manifestExists) {
    return statusNotInstalled();
  }
  const pidMetadata = await readHostPidMetadata(label.environment);
  if (pidMetadata !== null && isProcessAlive(pidMetadata.pid)) {
    return {
      state: "running",
      version: pidMetadata.version,
      listenUrl: pidMetadata.websocketUrl,
      pid: pidMetadata.pid,
    };
  }
  return { state: "stopped", version: null, listenUrl: null, pid: null };
}

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  await run("systemctl", ["--user", "stop", unitName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 15_000,
    tolerateNonZeroExit: true,
  });
}

async function startService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "start", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `systemctl start failed for ${unitName(label)}: ${describeCause(cause)}`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("systemctl", ["--user", "restart", unitName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 15_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `systemctl restart failed for ${unitName(label)}: ${describeCause(cause)}`,
      details: { unit: unitName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

function unitName(label: ServiceLabel): string {
  // systemd allows dots in unit-name prefixes - `ai.traycer.host.service`
  // parses unambiguously thanks to the `.service` suffix.
  return `${label.id}.service`;
}

function statusNotInstalled(): ServiceStatus {
  return { state: "not-installed", version: null, listenUrl: null, pid: null };
}

function describeCause(cause: unknown): string {
  if (cause instanceof ProcessRunError) {
    return `${cause.message} (exit=${cause.exitCode})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

interface BuildUnitOptions {
  readonly label: ServiceLabel;
  readonly cli: CliInvocation;
}

function buildUnit(options: BuildUnitOptions): string {
  const programArgs = [
    "/bin/sh",
    "-c",
    buildCompatibleHostStartScript(options.label.id),
    options.cli.command,
    ...options.cli.args,
  ];
  // systemd treats `%` as a specifier introducer and `;`/`\n`/`\t` as
  // line/argument separators inside an Exec= value. Reject any token
  // containing those rather than emit a unit file systemd parses
  // incorrectly - surface as SERVICE_INSTALL_FAILED with the offending
  // token so the operator can rename / relocate the binary.
  const forbidden = /[%;\n\t]/;
  const offending = programArgs.find((arg) => forbidden.test(arg));
  if (offending !== undefined) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `systemd unit: argument '${offending}' contains a character (% ; \\n \\t) that systemd would mis-parse in ExecStart; relocate the CLI binary to a path without these characters`,
      details: { offending, unit: `${options.label.id}.service` },
      exitCode: 1,
    });
  }
  // systemd ExecStart - quote each token so paths with spaces don't
  // break the unit file; backslash-escape inner quotes per the systemd
  // unit-file spec.
  const execStart = programArgs
    .map((arg) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(" ");
  // A definition can outlive the CLI it points at (the CLI package removed
  // while the unit stays enabled). Without the condition, every login then
  // exec's a missing $0, `Restart=on-failure` loops it into a `failed` unit
  // on every boot, and `systemctl --user is-system-running` degrades. With
  // it, systemd skips the start as "condition not met" - inert and visible
  // in `systemctl --user status`, not failing. A skipped condition does not
  // trigger Restart=, and a later `systemctl start` (the reinstall path)
  // re-evaluates it fresh. Conditions require absolute paths; the CLI
  // command always is one in production (guarded here for the self-invoke
  // fallback).
  const condition = isAbsolute(options.cli.command)
    ? `ConditionFileIsExecutable=${options.cli.command}\n`
    : "";
  // SyslogIdentifier: journald names a stream after the FIRST executable of
  // the Exec line - /bin/sh - and the stream is opened before the wrapper
  // exec's the CLI, so without this every supervisor line lands in the
  // journal as `sh[pid]`. The label id keys the lines to the exact
  // service instance (`journalctl --user -t ai.traycer.host`).
  return `[Unit]
Description=${options.label.displayName}
After=default.target
${condition}
[Service]
Type=simple
SyslogIdentifier=${options.label.id}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export { buildUnit as buildSystemdUnit };
