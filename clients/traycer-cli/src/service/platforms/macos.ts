import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { createCliLogger } from "../../logger";
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
import {
  serviceManifestPath,
  smAppServiceAgentLabelId,
  type ServiceLabel,
} from "../label";
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
    status: (label) => statusService(label, run),
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
  const guiTarget = guiDomain();
  const serviceTarget = `${guiTarget}/${options.label.id}`;
  // Refuse to take over a label Desktop already owns via SMAppService.
  // A stale `~/Library/LaunchAgents/<label>.plist` can coexist with an
  // in-bundle SMAppService load of the same label; bootout/bootstrap of
  // the raw path would corrupt BTM / CDHash state that Desktop manages.
  const ownership = await inspectLaunchdOwnership(serviceTarget, run);
  if (ownership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install: label '${options.label.id}' is owned by SMAppService (loaded from ${ownership.path}); the CLI must not bootout/bootstrap this label. Desktop owns registration on .app builds (host ensure --no-service-register).`,
      details: {
        label: options.label.id,
        loadedPath: ownership.path,
      },
      exitCode: 1,
    });
  }
  // Same refusal for the label-split world: post-split Desktop builds
  // register `<label>.agent` via SMAppService and leave the CLI label
  // unloaded. Without this probe, a manual `service install` beside a
  // desktop-owned agent would silently bootstrap a SECOND host under the
  // CLI label - two hosts racing over the same pid metadata and stores.
  const agentLabelId = smAppServiceAgentLabelId(options.label);
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiTarget}/${agentLabelId}`,
    run,
  );
  if (agentOwnership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install: Traycer Desktop owns host registration on this machine (SMAppService agent '${agentLabelId}' loaded from ${agentOwnership.path}); installing the raw '${options.label.id}' LaunchAgent would run a second host beside it. Use the Traycer app to repair the host (host ensure --no-service-register).`,
      details: {
        label: options.label.id,
        agentLabel: agentLabelId,
        loadedPath: agentOwnership.path,
      },
      exitCode: 1,
    });
  }
  const manifestPath = serviceManifestPath(options.label);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    buildPlist({ label: options.label, cli: options.cli }),
    "utf8",
  );
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
  if (ownership.kind !== "not-loaded") {
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
  // lifecycle's explicit stop-before-swap / re-register-after-swap
  // (service/install-lifecycle.ts), not this register step alone.
  //
  // Ticket a849b064: launchctl is run with `tolerateNonZeroExit: false`
  // so genuine failures (permission denied, malformed plist, missing
  // program, etc.) surface as `SERVICE_INSTALL_FAILED` / `SERVICE_CONTROL_FAILED`
  // instead of being silently swallowed. The only failure mode we still
  // classify as recoverable is the racey "service already bootstrapped"
  // case - and recovery is a full bootout → bootstrap reload against the
  // freshly written plist, never a bare kickstart of launchd's cache.
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
    // Already-loaded after our probe/bootout means another process
    // re-bootstrapped (or bootout did not fully clear) between steps.
    // Kickstart would only run the *cached* definition and leave the
    // regenerated SoftResourceLimits / ProgramArguments inactive - so
    // retry a full reload against the on-disk plist instead.
    await reloadRegisteredService({
      labelId: options.label.id,
      guiTarget,
      serviceTarget,
      manifestPath,
      run,
    });
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

interface ReloadRegisteredServiceOptions {
  readonly labelId: string;
  readonly guiTarget: string;
  readonly serviceTarget: string;
  readonly manifestPath: string;
  readonly run: ProcessRunner;
}

// Force launchd to drop and re-read the agent definition from disk.
// Used when bootstrap reports "already loaded" after we already wrote
// a new plist - kickstart alone does not apply that file.
async function reloadRegisteredService(
  options: ReloadRegisteredServiceOptions,
): Promise<void> {
  // The competing registrar that won the race this reload exists to fix
  // may be Desktop's SMAppService, not another CLI process - re-probe
  // ownership right before mutating. Booting out an SMAppService-owned job
  // would corrupt the BTM state Desktop manages, exactly what
  // `installService`'s own upfront refusal exists to prevent.
  const raceOwnership = await inspectLaunchdOwnership(
    options.serviceTarget,
    options.run,
  );
  if (raceOwnership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install: label '${options.labelId}' was taken over by SMAppService (loaded from ${raceOwnership.path}) during the reload race; the CLI must not bootout/bootstrap this label. Desktop owns registration on .app builds.`,
      details: { label: options.labelId, loadedPath: raceOwnership.path },
      exitCode: 1,
    });
  }
  try {
    await options.run("launchctl", ["bootout", options.serviceTarget], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    // Race may have cleared the job between the failed bootstrap and
    // this bootout; treat "not loaded" as success and continue to
    // bootstrap the fresh file. Real bootout failures must surface.
    if (!isBenignBootoutFailure(cause)) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `launchctl bootout failed for ${options.labelId} while recovering from bootstrap race: ${describeCause(cause)}`,
        details: {
          label: options.labelId,
          cause: describeCause(cause),
        },
        exitCode: 1,
      });
    }
  }
  try {
    await options.run(
      "launchctl",
      ["bootstrap", options.guiTarget, options.manifestPath],
      {
        env: undefined,
        cwd: undefined,
        timeoutMs: 10_000,
        tolerateNonZeroExit: false,
      },
    );
  } catch (cause) {
    // A second "already loaded" after our own explicit bootout means a
    // concurrent registrar won the reload race - and it bootstrapped the
    // same freshly regenerated on-disk plist this process just wrote (every
    // path that bootstraps this label rewrites the manifest first). The
    // loaded definition is therefore current, not the stale pre-rewrite
    // cache this reload exists to evict: treat it as success and let the
    // caller's kickstart run the winner's definition. Reporting
    // SERVICE_INSTALL_FAILED here failed a healthy install for losing a
    // benign race.
    //
    // But the winner of THIS race could also be Desktop's SMAppService
    // grabbing the label in the window between our own bootout and this
    // bootstrap attempt - re-verify before accepting the failure as benign,
    // since kickstart-ing "the winner's definition" would otherwise
    // kickstart Desktop's SMAppService-owned job.
    if (isBenignBootstrapFailure(cause)) {
      const postRaceOwnership = await inspectLaunchdOwnership(
        options.serviceTarget,
        options.run,
      );
      if (postRaceOwnership.kind === "smappservice") {
        throw cliError({
          code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
          message: `service install: label '${options.labelId}' was taken over by SMAppService (loaded from ${postRaceOwnership.path}) after the CLI's own bootout; the CLI's install did not complete. Desktop now owns this label.`,
          details: {
            label: options.labelId,
            loadedPath: postRaceOwnership.path,
          },
          exitCode: 1,
        });
      }
      return;
    }
    // A genuine second-bootstrap failure leaves the label fully
    // deregistered (the bootout above already succeeded) - launchd has no
    // atomic reload, so this window is inherent. Fail closed with the
    // explicit error rather than kickstart a definition we know is gone.
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `launchctl bootstrap failed for ${options.labelId} after reload retry; the previous registration was booted out, so the service is now unregistered until 'traycer host service install' succeeds: ${describeCause(cause)}`,
      details: {
        label: options.labelId,
        cause: describeCause(cause),
      },
      exitCode: 1,
    });
  }
}

// Ownership of a launchd label from the CLI's point of view.
//
// Desktop .app builds register the same reverse-DNS label via SMAppService
// against the *in-bundle* LaunchAgent
// (`<App>.app/Contents/Library/LaunchAgents/<label>.plist`). The CLI owns
// the raw user-domain path (`~/Library/LaunchAgents/<label>.plist`). When
// both exist, status used to treat the raw file as "CLI registered" and
// host update reloaded it - bootouting the SMAppService-managed job.
type LaunchdOwnership =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "smappservice"; readonly path: string }
  | { readonly kind: "cli-or-other"; readonly path: string | null };

// Probe launchd for who currently owns this label. `launchctl print`
// exits 0 when loaded and includes `path = <plist>`; non-zero means not
// loaded. Tolerate non-zero so a fresh install skips bootout. Genuine
// launchctl unavailability surfaces later at bootstrap with a clearer
// error.
//
// Point-in-time by design: this reads what launchd has LOADED right now.
// With Desktop's login item disabled (requires-approval) or BTM unloaded,
// the label reads `not-loaded` even though an SMAppService registration
// record exists - a stale raw `~/Library/LaunchAgents` plist can then
// re-register here and recreate the dual-registration collision when the
// user re-enables the login item. Detecting the unloaded-record case would
// need SMAppService itself (only callable from inside the .app), so the
// CLI accepts this edge; Desktop's own register cycle (bootout first)
// self-heals it on its next ensure.
async function inspectLaunchdOwnership(
  serviceTarget: string,
  run: ProcessRunner,
): Promise<LaunchdOwnership> {
  const result = await run("launchctl", ["print", serviceTarget], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  });
  if (result.exitCode !== 0) {
    return { kind: "not-loaded" };
  }
  const path = parseLaunchctlPrintPath(`${result.stdout}\n${result.stderr}`);
  if (path !== null && isSmAppServiceLaunchAgentPath(path)) {
    return { kind: "smappservice", path };
  }
  return { kind: "cli-or-other", path };
}

// SMAppService agent plists live at
// `<Something>.app/Contents/Library/LaunchAgents/<name>.plist` (see
// desktop `host-login-item.ts` / packaging). The CLI-owned path is always
// under `~/Library/LaunchAgents/`.
function isSmAppServiceLaunchAgentPath(plistPath: string): boolean {
  return /\/[^/]+\.app\/Contents\/Library\/LaunchAgents\//i.test(plistPath);
}

// Extract `path = ...` from `launchctl print` output. Format is stable
// enough across recent macOS releases; missing path is treated as
// non-SMAppService (fail open to CLI ownership for CLI-managed installs).
function parseLaunchctlPrintPath(printOutput: string): string | null {
  const match = printOutput.match(/^\s*path\s*=\s*(.+?)\s*$/m);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined || raw.length === 0) return null;
  return raw;
}

// launchctl returns "Service is already loaded" / "Bootstrap failed:
// 37: ... (already loaded)" when the agent is already registered. We
// classify these as *recoverable races* (not success): the caller must
// bootout + bootstrap the on-disk plist before kickstart, because
// kickstart alone runs launchd's cached definition. Everything else
// (permission denied, malformed plist, missing program, ...) surfaces
// as a real failure immediately.
//
// Detection is intentionally string-shape-tolerant rather than exit-code-
// pinned: launchctl has changed exit codes between macOS releases and
// the stderr line is the more stable signal.
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
  // Deliberate asymmetry with `installService`'s SMAppService refusal: the
  // refusal exists because bootout + bootstrap of the RAW plist would
  // corrupt / dual-register the BTM state Desktop manages. Uninstall only
  // removes - bootout is the strongest teardown the CLI has (and on macOS
  // 26+ it is exactly what flushes the BTM entry), and refusing here would
  // strand users whose .app is already gone with an un-removable agent.
  // Desktop's own in-app uninstall unregisters SMAppService BEFORE invoking
  // this, so it never hits this branch. What the CLI cannot do is drop the
  // SMAppService *record* on macOS <= 25 - warn so the leftover login item
  // (which can respawn the host at next login) is not a silent surprise.
  //
  // The probe is advisory only: a launchctl that hangs or cannot spawn must
  // never block a removal, so probe failures read as "not loaded".
  const ownership = await inspectLaunchdOwnership(serviceTarget, run).catch(
    (): LaunchdOwnership => ({ kind: "not-loaded" }),
  );
  if (ownership.kind === "smappservice") {
    createCliLogger(options.label.environment).warn(
      "Service uninstall: label is registered by Traycer Desktop's login item (SMAppService); booting it out now, but macOS may keep the login-item record. If the host reappears at next login, remove Traycer in the Desktop app or System Settings -> Login Items.",
      { label: options.label.id, loadedPath: ownership.path },
    );
  }
  // Post-label-split Desktop builds run the host under `<label>.agent`;
  // tear that job down too (agent first - it is the live one on such
  // machines) so `host uninstall --all` doesn't leave a running host
  // pointed at the install dir being removed. Same BTM-record caveat as
  // the CLI-label bootout above.
  const agentLabelId = smAppServiceAgentLabelId(options.label);
  const agentTarget = `${guiDomain()}/${agentLabelId}`;
  const agentOwnership = await inspectLaunchdOwnership(agentTarget, run).catch(
    (): LaunchdOwnership => ({ kind: "not-loaded" }),
  );
  if (agentOwnership.kind === "smappservice") {
    createCliLogger(options.label.environment).warn(
      "Service uninstall: Traycer Desktop's SMAppService agent is registered for this environment; booting it out now, but macOS may keep the login-item record. If the host reappears at next login, remove Traycer in the Desktop app or System Settings -> Login Items.",
      { label: agentLabelId, loadedPath: agentOwnership.path },
    );
  }
  // Attempt both targets even when one fails hard: a hard failure on the
  // agent label (iterated first, since it's the live job on migrated
  // machines) must not skip the CLI-label bootout - `host uninstall --all`
  // promises best-effort-per-target cleanup, not "stop at the first
  // failure". The manifest `rm` below stays gated on BOTH attempts being
  // clean (success or benign not-loaded): `statusService` treats a missing
  // manifest as "not-installed", so deleting it after a genuinely failed
  // bootout would misreport a still-loaded job as gone.
  const bootoutFailures: Array<{ labelId: string; cause: unknown }> = [];
  for (const [labelId, target] of [
    [agentLabelId, agentTarget],
    [options.label.id, serviceTarget],
  ] as const) {
    try {
      await run("launchctl", ["bootout", "--wait", target], {
        env: undefined,
        cwd: undefined,
        // `--wait` is launchd's authoritative completion barrier but may
        // block indefinitely. Keep the subprocess bound above the host's
        // own forced shutdown watchdog so normal graceful shutdown has
        // time to finish.
        timeoutMs: STOP_EXIT_TIMEOUT_MS,
        tolerateNonZeroExit: false,
      });
    } catch (cause) {
      if (!isBenignBootoutFailure(cause)) {
        bootoutFailures.push({ labelId, cause });
      }
    }
  }
  if (bootoutFailures.length > 0) {
    const [{ labelId, cause }] = bootoutFailures;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl bootout failed for ${labelId}: ${describeCause(cause)}`,
      details: { label: labelId, cause: describeCause(cause) },
      exitCode: 1,
    });
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

async function statusService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<ServiceStatus> {
  // SMAppService-owned loads of this label are not CLI-managed, even when a
  // stale raw LaunchAgents plist still exists on disk from a prior
  // CLI-managed install. Reporting the dedicated `externally-managed` state
  // (NOT `not-installed`) does two things at once: install-lifecycle /
  // provisioning still stay away from the reload path (stop +
  // bootout/bootstrap) against Desktop's BTM registration, and
  // auto-bootstrap / doctor see that a registration exists - `not-installed`
  // here used to make every `traycer login` on a Desktop-managed machine
  // select "service repair" and run straight into `installService`'s
  // SMAppService refusal.
  const serviceTarget = `${guiDomain()}/${label.id}`;
  const ownership = await inspectLaunchdOwnership(serviceTarget, run);
  if (ownership.kind === "smappservice") {
    return {
      state: "externally-managed",
      version: null,
      listenUrl: null,
      pid: null,
    };
  }
  // Post-label-split Desktop builds register `<label>.agent` and leave the
  // CLI label unloaded with its raw manifest deleted - without this probe
  // such a machine reads `not-installed` and doctor/auto-bootstrap route
  // into `installService`'s agent-label refusal instead of recognizing the
  // healthy Desktop-owned registration.
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiDomain()}/${smAppServiceAgentLabelId(label)}`,
    run,
  );
  if (agentOwnership.kind === "smappservice") {
    return {
      state: "externally-managed",
      version: null,
      listenUrl: null,
      pid: null,
    };
  }
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

// Fail fast when Traycer Desktop's post-label-split SMAppService agent owns
// the host for this environment. stop/start/restart operate on the CLI
// label's launchd job; on a migrated machine that job doesn't exist - `stop`
// would signal nothing, wait out the full shutdown grace against a host that
// never received SIGTERM, and report a misleading "stop did not take
// effect", while `start`/`restart` would surface raw kickstart errors with
// no routing. Mirrors `statusService`'s externally-managed detection. The
// probe is advisory (a hung/unspawnable launchctl reads as not-loaded) so it
// can never block the operation on a genuinely CLI-managed machine.
async function assertNotDesktopAgentManaged(
  label: ServiceLabel,
  operation: string,
  run: ProcessRunner,
): Promise<void> {
  const agentLabelId = smAppServiceAgentLabelId(label);
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiDomain()}/${agentLabelId}`,
    run,
  ).catch((): LaunchdOwnership => ({ kind: "not-loaded" }));
  if (agentOwnership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `host ${operation}: Traycer Desktop owns host registration on this machine (SMAppService agent '${agentLabelId}' loaded from ${agentOwnership.path}); the CLI does not manage this host. Use the Traycer app to ${operation} it.`,
      details: {
        label: label.id,
        agentLabel: agentLabelId,
        loadedPath: agentOwnership.path,
      },
      exitCode: 1,
    });
  }
}

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  await assertNotDesktopAgentManaged(label, "stop", run);
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
  await assertNotDesktopAgentManaged(label, "start", run);
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
  await assertNotDesktopAgentManaged(label, "restart", run);
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
// Keep in lockstep with the in-app SMAppService plist generator in the
// internal repository's scripts/desktop-install-cloud.js.
const HOST_SOFT_FILE_DESCRIPTOR_LIMIT = 8_192;

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
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>${HOST_SOFT_FILE_DESCRIPTOR_LIMIT}</integer>
  </dict>
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

/**
 * Read the CLI invocation the currently registered macOS LaunchAgent plist
 * points at, or `null` when there is no readable/parsable manifest or its
 * command no longer exists on disk.
 *
 * Used by `host update`'s existing-registration re-register: the update
 * regenerates the plist to apply definition changes (SoftResourceLimits,
 * env), but it must not silently REPOINT `ProgramArguments` at whatever
 * `resolveServiceCliInvocation` currently prefers - a brew/manual user who
 * once ran Desktop's setup has a stale staged `~/.traycer/cli` binary that
 * would win resolution over the brew binary their plist actually invokes.
 * Preserving the registered command keeps `host update`'s historical "never
 * repoints the service" contract while still refreshing the definition.
 *
 * Only ever parses a plist this module's `buildPlist` wrote, so the shape
 * is known: `ProgramArguments` = [command, ...leadingArgs, "host", "start"].
 */
async function readRegisteredCliInvocation(
  label: ServiceLabel,
): Promise<CliInvocation | null> {
  let xml: string;
  try {
    xml = await readFile(serviceManifestPath(label), "utf8");
  } catch {
    return null;
  }
  const arrayMatch = xml.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (arrayMatch === null) return null;
  const body = arrayMatch[1];
  if (body === undefined) return null;
  const args = [...body.matchAll(/<string>([\s\S]*?)<\/string>/g)]
    .map((m) => m[1])
    .filter((value): value is string => value !== undefined)
    .map(unescapeXml);
  if (args.length < 3) return null;
  if (args[args.length - 2] !== "host" || args[args.length - 1] !== "start") {
    return null;
  }
  const command = args[0];
  if (command === undefined || !(await fileExists(command))) return null;
  return { command, args: args.slice(1, -2) };
}

// Inverse of `escapeXml`'s five replacements (`&amp;` last so a literal
// `&lt;` round-trips instead of double-decoding).
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export {
  buildPlist as buildLaunchAgentPlist,
  isSmAppServiceLaunchAgentPath,
  parseLaunchctlPrintPath,
  readRegisteredCliInvocation,
};
