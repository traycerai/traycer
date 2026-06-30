import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
import { escapeXml } from "../escape-xml";
import { windowsTaskName, type ServiceLabel } from "../label";
import { ProcessRunError, runCommand } from "../process-runner";
import type {
  InstallServiceOptions,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";

// Windows service controller - per-user Scheduled Task. Per the Tech
// Plan we never elevate; if a future change ever needed admin we'd
// fall back to user-only and surface a doctor message rather than
// prompting for UAC.

// Pluggable runner shape kept consistent with macOS so the three
// platform-controller factories expose the same signature. Windows
// currently doesn't thread the runner through; production calls
// `runCommand` directly. Tests pass `null`.
export type ProcessRunner = typeof runCommand;

export function createWindowsController(
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

async function installService(options: InstallServiceOptions): Promise<void> {
  const taskName = windowsTaskName(options.label);
  // schtasks /Create /XML reads the task definition from disk. Stage it inside a
  // private per-invocation directory (mkdtemp ⇒ mode 0700 with an unguessable
  // suffix) rather than a predictable name in the shared tmpdir, so a local
  // attacker can't pre-create or symlink the path we're about to write.
  const tmpDir = await mkdtemp(join(tmpdir(), "traycer-task-"));
  const xmlPath = join(tmpDir, "task.xml");
  // schtasks /Create /XML requires UTF-16 LE with BOM. Anything else
  // fails with "The specified file is not a valid XML file". Node's
  // built-in `utf16le` encoder paired with a leading U+FEFF BOM
  // handles surrogate pairs / non-BMP code points (emoji, etc.) that
  // the hand-rolled writeUInt16LE-per-char loop would corrupt.
  const xmlBody = buildTaskXml({ label: options.label, cli: options.cli });
  await writeFile(xmlPath, Buffer.from(`﻿${xmlBody}`, "utf16le"));
  try {
    await runCommand(
      "schtasks",
      ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 30_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `schtasks /Create failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
  // Kick the task immediately so the host comes up without waiting
  // for the next logon.
  await runCommand("schtasks", ["/Run", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: false,
  });
}

async function uninstallService(
  options: UninstallServiceOptions,
): Promise<void> {
  const taskName = windowsTaskName(options.label);
  await runCommand("schtasks", ["/End", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  await runCommand("schtasks", ["/Delete", "/TN", taskName, "/F"], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
}

async function statusService(label: ServiceLabel): Promise<ServiceStatus> {
  const taskName = windowsTaskName(label);
  let registered: boolean;
  try {
    await runCommand("schtasks", ["/Query", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
    registered = true;
  } catch (err) {
    if (err instanceof ProcessRunError) {
      registered = false;
    } else {
      throw err;
    }
  }
  if (!registered) {
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
  await runCommand("schtasks", ["/End", "/TN", windowsTaskName(label)], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
}

async function startService(label: ServiceLabel): Promise<void> {
  try {
    await runCommand("schtasks", ["/Run", "/TN", windowsTaskName(label)], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${windowsTaskName(label)}: ${describeCause(cause)}`,
      details: { task: windowsTaskName(label), cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function restartService(label: ServiceLabel): Promise<void> {
  const taskName = windowsTaskName(label);
  await runCommand("schtasks", ["/End", "/TN", taskName], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 30_000,
    tolerateNonZeroExit: true,
  });
  try {
    await runCommand("schtasks", ["/Run", "/TN", taskName], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `schtasks /Run failed for ${taskName}: ${describeCause(cause)}`,
      details: { task: taskName, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
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

interface BuildTaskXmlOptions {
  readonly label: ServiceLabel;
  readonly cli: CliInvocation;
}

// Quote a single token for a Windows command line the way CommandLineToArgvW
// parses it: a backslash is literal unless it runs up to a `"`. So we double
// only the backslashes immediately before a quote (escaping the quote with one
// extra) and those before the closing quote we append, leaving interior path
// separators like the ones in `C:\Users\foo` untouched.
function quoteWindowsArg(arg: string): string {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

function buildTaskXml(options: BuildTaskXmlOptions): string {
  // <Command> takes a single executable; <Arguments> takes the rest as
  // a single string. schtasks parses the latter with shell rules, so
  // quote each token explicitly.
  const argv = [...options.cli.args, "host", "start"];
  const argumentsLine = argv.map(quoteWindowsArg).join(" ");
  const userId = resolveTaskUserId();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(options.label.displayName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(options.cli.command)}</Command>
      <Arguments>${escapeXml(argumentsLine)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// Resolve the Task XML `<UserId>` value. schtasks requires a fully
// qualified `<domain>\<name>` for domain-joined machines and accepts a
// bare `<name>` for local accounts. We can't easily distinguish the two
// from inside Node without Win32 API calls, so we lean on the env vars
// that the shell sets at logon:
//   - USERDOMAIN + USERNAME both set, non-empty → `<domain>\<name>`
//   - USERNAME only → bare `<name>` (local-account path)
//   - neither → fail closed; missing identity would produce a Task XML
//     that schtasks rejects with a confusing error
//
// TODO(microsoft-account-sid): For users signed in with a Microsoft
// account, Windows exposes the identity as a SID
// (`S-1-12-1-...`) reached through the LookupAccountName / NetUserGetInfo
// Win32 APIs. That requires a native helper out of scope for this fix.
// The current heuristic is correct for the local + domain-joined
// majority; MSA users will see the bare USERNAME fallback, which
// schtasks usually accepts for their local profile.
function resolveTaskUserId(): string {
  const domain = process.env.USERDOMAIN ?? "";
  const name = process.env.USERNAME ?? "";
  if (domain.length > 0 && name.length > 0) {
    return `${domain}\\${name}`;
  }
  if (name.length > 0) {
    return name;
  }
  throw cliError({
    code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
    message:
      "schtasks: cannot resolve a Task XML <UserId>; neither USERDOMAIN nor USERNAME is set in the environment. " +
      "Run `traycer host service install` from an interactive logon session.",
    details: { USERDOMAIN: domain, USERNAME: name },
    exitCode: 1,
  });
}

export { buildTaskXml as buildScheduledTaskXml };
