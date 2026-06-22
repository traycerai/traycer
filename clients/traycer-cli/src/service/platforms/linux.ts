import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
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

// Linux currently doesn't use the pluggable runner test seam - the
// systemctl/loginctl calls go straight to `runCommand`. Take the
// argument anyway so the three platform-controller factories share one
// signature (`createMacos|Linux|WindowsController(runner: ProcessRunner | null)`).
// Tests on Linux can pass `null`; production callers always pass null.
export function createLinuxController(
  _runner: ProcessRunner | null,
): ServiceController {
  return {
    install: (options) => installService(options),
    uninstall: (options) => uninstallService(options),
    status: (label) => statusService(label),
    stop: (label) => stopService(label),
    start: (label) => startService(label),
    restart: (label) => restartService(label),
  };
}

// Pluggable runner shape kept consistent with macOS so the three
// controllers expose the same factory signature, even when Linux
// doesn't currently use the seam.
export type ProcessRunner = typeof runCommand;

async function installService(options: InstallServiceOptions): Promise<void> {
  const manifestPath = serviceManifestPath(options.label);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    buildUnit({ label: options.label, cli: options.cli }),
    "utf8",
  );
  // daemon-reload picks up the new unit; enable --now both registers
  // the auto-start and starts the unit immediately.
  await runCommand("systemctl", ["--user", "daemon-reload"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: false,
  });
  try {
    await runCommand(
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
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `systemctl enable --now failed for ${unitName(options.label)}: ${describeCause(cause)}`,
      details: { unit: unitName(options.label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
  if (options.enableLinger) {
    await tryEnableLinger();
  }
}

async function tryEnableLinger(): Promise<void> {
  const user = process.env.USER ?? process.env.USERNAME ?? "";
  if (user.length === 0) return;
  // Tolerate non-zero exit so a polkit prompt or already-enabled state
  // doesn't fail the install. Doctor flags the absence later.
  await runCommand("loginctl", ["enable-linger", user], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
}

async function uninstallService(
  options: UninstallServiceOptions,
): Promise<void> {
  await runCommand(
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
  await runCommand("systemctl", ["--user", "daemon-reload"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
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

async function stopService(label: ServiceLabel): Promise<void> {
  await runCommand("systemctl", ["--user", "stop", unitName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 15_000,
    tolerateNonZeroExit: true,
  });
}

async function startService(label: ServiceLabel): Promise<void> {
  try {
    await runCommand("systemctl", ["--user", "start", unitName(label)], {
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

async function restartService(label: ServiceLabel): Promise<void> {
  try {
    await runCommand("systemctl", ["--user", "restart", unitName(label)], {
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
    options.cli.command,
    ...options.cli.args,
    "host",
    "start",
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
  return `[Unit]
Description=${options.label.displayName}
After=default.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export { buildUnit as buildSystemdUnit };
