import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
import { HOST_V8_FLAGS } from "../host-node-options";
import { escapeXml } from "../escape-xml";
import { fileExists } from "../install-binary";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import { serviceManifestPath, type ServiceLabel } from "../label";
import {
  ProcessRunError,
  runCommand,
  type RunOptions,
  type RunResult,
} from "../process-runner";
import type {
  InstallServiceOptions,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";

// macOS service controller - CLI-owned launchctl. There is intentionally
// no `SMAppService` path here (Decision 1 of the Tech Plan); the
// CLI is the only owner of the host's lifecycle, and Desktop drives
// it via subprocess calls. The plist invokes the per-user CLI binary
// with `host start` (the slot is baked into the CLI build via
// `config.environment`, so no flag is passed), never the host binary
// directly. NOTE: a launchctl agent pointing at a bare CLI binary/wrapper
// has no responsible `.app`, so its System Settings → Login Items row has
// no icon. The icon-attributed row is produced only by the desktop's
// `SMAppService` registration of the in-bundle plist (see
// `electron-main/app/host-login-item.ts`), which shipped builds use.

// Pluggable runner so tests can stub launchctl behaviour without
// spawning a real subprocess. Production callers leave it `undefined`
// and we fall back to the real `runCommand`.
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

export function createMacosController(
  runner: ProcessRunner | null,
): ServiceController {
  const run: ProcessRunner = runner ?? runCommand;
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label),
    stop: (label) => stopService(label, run),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run),
  };
}

async function installService(
  options: InstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  // Register the host by writing a user-domain LaunchAgent plist:
  // `RunAtLoad` makes it auto-start at login and surface in System Settings →
  // Login Items / "Allow in the Background" (that BTM row is driven by the
  // registration itself, not by `ProcessType`). `ProcessType: Standard` keeps
  // the host out of launchd's throttled Background band - it does
  // latency-sensitive RPC work and being CPU/IO-throttled (and pinned to
  // efficiency cores on Apple Silicon) starved the event loop on open.
  const manifestPath = serviceManifestPath(options.label);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    buildPlist({ label: options.label, cli: options.cli }),
    "utf8",
  );
  const guiTarget = guiDomain();
  const serviceTarget = `${guiTarget}/${options.label.id}`;
  // Reload pattern: only `bootout` when there is actually an existing
  // registration to remove, then bootstrap the freshly-written plist.
  // launchctl's `bootstrap` rejects a re-load with mixed error shapes -
  // sometimes a clean "already loaded" message (exit 37), and sometimes
  // EIO / "Input/output error" (exit 5) when the on-disk plist conflicts
  // with the version launchd already holds. The EIO branch was breaking
  // the Settings → Re-register path.
  //
  // Probing with `launchctl print` first instead of unconditionally
  // calling bootout has two benefits over a blanket
  // `tolerateNonZeroExit: true` bootout:
  //   1. Real bootout failures (permission denied, corrupted launchd
  //      state) are surfaced as `SERVICE_INSTALL_FAILED` instead of
  //      being silently swallowed and rediscovered as a downstream
  //      bootstrap symptom.
  //   2. On a fresh machine where no service is loaded, we skip
  //      bootout entirely - bootstrap can't be left in a state worse
  //      than "registered" by a failed bootout because we never call
  //      bootout. On an existing registration where bootstrap then
  //      fails, the user keeps their old registration intact (the
  //      previous reload pattern would unconditionally bootout and
  //      then fail bootstrap, leaving the user completely
  //      unregistered).
  //
  // `isBenignBootstrapFailure` below stays as defence-in-depth for the
  // race where another process re-bootstraps between our probe and our
  // bootstrap call.
  if (await isServiceLoaded(serviceTarget, run)) {
    await run("launchctl", ["bootout", serviceTarget], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    }).catch((cause: unknown) => {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `launchctl bootout failed for ${options.label.id}: ${describeCause(cause)}`,
        details: { label: options.label.id, cause: describeCause(cause) },
        exitCode: 1,
      });
    });
  }
  // `bootstrap` loads the agent into launchd; plain `kickstart` (NOT
  // `kickstart -k`) then ensures it is running. We deliberately avoid
  // `-k`: the plist sets `ThrottleInterval: 10`, so force-killing a
  // healthy host would make launchd block the respawn ~10s. Version
  // swaps that genuinely need a fresh process go through the install
  // lifecycle's explicit stop-before-swap / restart-after-swap
  // (service/install-lifecycle.ts), not this register step.
  //
  // Ticket a849b064: launchctl is run with `tolerateNonZeroExit: false`
  // so genuine failures (permission denied, malformed plist, missing
  // program, etc.) surface as `SERVICE_INSTALL_FAILED` / `SERVICE_CONTROL_FAILED`
  // instead of being silently swallowed. The only failure mode we still
  // tolerate is the *idempotent* "service already bootstrapped" case,
  // which launchd reports with a recognizable stderr message + exit code.
  // Doctor and first-launch readiness both rely on this signal to drive
  // recovery cards, so the previous blanket tolerance was masking real
  // bugs (the user saw a clean install + later a host-not-ready
  // failure with no service-install diagnostic to link them).
  try {
    await run("launchctl", ["bootstrap", guiTarget, manifestPath], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (!isBenignBootstrapFailure(cause)) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `launchctl bootstrap failed for ${options.label.id}: ${describeCause(cause)}`,
        details: { label: options.label.id, cause: describeCause(cause) },
        exitCode: 1,
      });
    }
    // Already-loaded is fine - the agent's plist on disk has been
    // refreshed by the writeFile above; the kickstart below ensures it
    // is running against the new manifest.
  }
  try {
    await run("launchctl", ["kickstart", `${guiTarget}/${options.label.id}`], {
      env: undefined,
      cwd: undefined,
      // 30s, not 10s: the dev wrapper at ~/.traycer/cli/dev/bin/traycer
      // exec's `bun src/index.ts` - bun cold-start across ~2500 TS
      // files plus the host's first-boot work can comfortably exceed
      // 10s on a loaded laptop.
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart failed for ${options.label.id}: ${describeCause(cause)}`,
      details: { label: options.label.id, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

// Probe whether an agent with this label is currently bootstrapped in the
// gui domain. `launchctl print <target>` exits 0 when loaded, non-zero
// when not. We tolerate non-zero (treat as "not loaded") so a fresh
// install bypasses bootout entirely - only existing registrations get
// torn down and recreated. Genuine launchctl unavailability (binary
// missing, etc.) would manifest later in bootstrap with a clearer error.
async function isServiceLoaded(
  serviceTarget: string,
  run: ProcessRunner,
): Promise<boolean> {
  const result = await run("launchctl", ["print", serviceTarget], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
  return result.exitCode === 0;
}

// launchctl returns ENOENT / "Service is already loaded" / "Bootstrap
// failed: 37: ... (already loaded)" when the agent is already
// registered. We classify these as benign because the writeFile above
// has just overwritten the plist on disk and the upcoming
// `kickstart -k` will force a fresh spawn - net effect is the same as
// a clean install. Everything else (permission denied, malformed plist,
// missing program, ...) must surface as a real failure.
//
// Detection is intentionally string-shape-tolerant rather than exit-code-
// pinned: launchctl has changed exit codes between macOS releases and
// the stderr line is the more stable signal. Exit-code 37 is included
// as a corroborating hint because it's what `launchctl bootstrap`
// historically returns for EEXIST.
function isBenignBootstrapFailure(cause: unknown): boolean {
  if (!(cause instanceof ProcessRunError)) return false;
  const haystack = `${cause.stderr}\n${cause.stdout}`.toLowerCase();
  if (
    haystack.includes("already loaded") ||
    haystack.includes("service is already") ||
    haystack.includes("already bootstrapped")
  ) {
    return true;
  }
  return false;
}

async function uninstallService(
  options: UninstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  const serviceTarget = `${guiDomain()}/${options.label.id}`;
  try {
    await run("launchctl", ["bootout", "--wait", serviceTarget], {
      env: undefined,
      cwd: undefined,
      // `--wait` is launchd's authoritative completion barrier but may block
      // indefinitely. Keep the subprocess bound above the host's own forced
      // shutdown watchdog so normal graceful shutdown has time to finish.
      timeoutMs: STOP_EXIT_TIMEOUT_MS,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (!isBenignBootoutFailure(cause)) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `launchctl bootout failed for ${options.label.id}: ${describeCause(cause)}`,
        details: { label: options.label.id, cause: describeCause(cause) },
        exitCode: 1,
      });
    }
  }
  await rm(serviceManifestPath(options.label), { force: true });
}

function isBenignBootoutFailure(cause: unknown): boolean {
  if (!(cause instanceof ProcessRunError)) return false;
  const haystack = `${cause.stderr}\n${cause.stdout}`.toLowerCase();
  return (
    haystack.includes("no such process") ||
    haystack.includes("could not find specified service")
  );
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

// Grace window for the host process to actually exit after SIGTERM. In
// normal operation graceful shutdown completes in milliseconds, so the poll
// below resolves almost immediately. As a last resort the host arms a
// force-exit watchdog (`SHUTDOWN_FORCE_EXIT_MS`) for the case where close()
// itself wedges. This grace MUST stay above that watchdog: if it gives up
// first it reports a spurious "stop did not take effect" failure - and aborts
// `restart` before it re-launches - for a host that is in fact guaranteed to
// exit moments later. Derived from the SHARED constants (not a hand-tuned
// literal) so raising the watchdog can't silently leave this grace too short.
const STOP_EXIT_TIMEOUT_MS = SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
const STOP_EXIT_POLL_MS = 150;

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  // Snapshot the live host pid BEFORE signalling so we can confirm the
  // process truly exits. `host restart` does stop→start: if `start`'s
  // kickstart fires while the old process is still winding down, launchd
  // sees the job as already-running and the kickstart no-ops - leaving the
  // host DOWN after a "restart" (and `host stop` reporting success
  // while the host keeps serving). Waiting for real exit here is what
  // makes both commands actually take effect.
  const before = await readHostPidMetadata(label.environment);
  await run("launchctl", ["kill", "TERM", `${guiDomain()}/${label.id}`], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
  if (before === null) return;
  const exited = await waitForPidExit(
    before.pid,
    STOP_EXIT_TIMEOUT_MS,
    STOP_EXIT_POLL_MS,
  );
  // The whole point of waiting is that `host stop`/`restart` only take effect
  // once the old process is gone (a `start` kickstart no-ops while launchd
  // still sees the job running). A timeout means the host is still serving,
  // so surface it as a failure instead of reporting success on a no-op stop.
  if (!exited) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `host (pid=${before.pid}) did not exit within ${STOP_EXIT_TIMEOUT_MS}ms of SIGTERM; stop did not take effect.`,
      details: {
        label: label.id,
        pid: before.pid,
        timeoutMs: STOP_EXIT_TIMEOUT_MS,
      },
      exitCode: 1,
    });
  }
}

// Poll until `pid` is no longer alive or the deadline passes. Returns `true`
// once the process is observed gone, `false` if it is still alive at the
// deadline (the caller decides whether that is a hard failure). KeepAlive is
// `{SuccessfulExit:false}` so a clean SIGTERM exit is not auto-respawned,
// meaning the pid stays dead once observed.
async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  // Final check: the process may have exited during the last poll sleep, right
  // as the deadline elapsed.
  return !isProcessAlive(pid);
}

async function startService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("launchctl", ["kickstart", `${guiDomain()}/${label.id}`], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart failed for ${label.id}: ${describeCause(cause)}`,
      details: { label: label.id, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  try {
    await run("launchctl", ["kickstart", "-k", `${guiDomain()}/${label.id}`], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart -k failed for ${label.id}: ${describeCause(cause)}`,
      details: { label: label.id, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
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

interface BuildPlistOptions {
  readonly label: ServiceLabel;
  readonly cli: CliInvocation;
}

// System PATH floor so the host always has the OS basics even if the
// install-time PATH is unusual.
const SYSTEM_PATH_FLOOR =
  "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin";

/**
 * The PATH to bake into the host's LaunchAgent. launchd would otherwise
 * give the host a bare PATH that can't see provider CLIs installed via
 * nvm/Homebrew/asdf/etc. `host install` is normally invoked from the
 * user's shell (e.g. `make install-desktop-*`, `traycer host install`),
 * so `process.env.PATH` here is the user's real PATH - capture it (in
 * order, so `which`-equivalent resolution works) and append the system
 * floor. This is why a terminal-launched host "just works": it inherits
 * this same PATH.
 */
function hostAgentPath(): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of `${process.env.PATH ?? ""}:${SYSTEM_PATH_FLOOR}`.split(
    ":",
  )) {
    if (dir.length > 0 && !seen.has(dir)) {
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(":");
}

function buildPlist(options: BuildPlistOptions): string {
  const home = homedir();
  const programArgs = [
    options.cli.command,
    ...options.cli.args,
    "host",
    "start",
  ];
  const programArgsXml = programArgs
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label.id)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(hostAgentPath())}</string>
    <key>NODE_OPTIONS</key>
    <string>${escapeXml(HOST_V8_FLAGS)}</string>
  </dict>
</dict>
</plist>
`;
}

export { buildPlist as buildLaunchAgentPlist };
