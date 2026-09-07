import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { readHostPidMetadata } from "../../host/pid-metadata";
import { createCliLogger } from "../../logger";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { isProcessAlive } from "../../store/cli-lock";
import type { CliInvocation } from "../cli-binary";
import { HOST_V8_FLAGS } from "../host-node-options";
import { escapeXml } from "../escape-xml";
import {
  buildHostStartLauncherScript,
  COMPATIBLE_HOST_START_SCRIPT_PREFIX,
} from "./host-start-script";
import { fileExists } from "../install-binary";
import {
  SHUTDOWN_FORCE_EXIT_MS,
  STOP_EXIT_GRACE_MARGIN_MS,
} from "@traycer/protocol/host/lifecycle-constants";
import {
  serviceLauncherScriptPath,
  serviceManifestPath,
  smAppServiceAgentLabelId,
  type ServiceLabel,
} from "../label";
// The launchctl-print parsing primitives are the shared module's - one implementation for every consumer.
// The depth-enforced parser (top-level fields only, `^\t?` anchor) replaces the any-depth variant that used to live here, so a nested `path` inside `endpoints = { ... }` can never masquerade as the job's plist path.
import {
  forceStopHostProcess,
  requestCooperativeShutdown,
} from "./desktop-agent-shutdown";
import {
  classifyLaunchctlPrintResult,
  deriveWedgeVerdict,
  type ProbeCommandResult,
  isSmAppServiceLaunchAgentPath,
  parseLaunchctlPrintFields,
  SMAPPSERVICE_PATH_UNKNOWN,
  SERVICE_MANAGEMENT_JOB_TYPE,
  SERVICE_MANAGEMENT_MANAGED_BY,
} from "@traycer-clients/shared/host-lifecycle";
import {
  ProcessRunError,
  ProcessSpawnError,
  runCommand,
  type RunOptions,
  type RunResult,
} from "../process-runner";
import type {
  CompetingRegistrationRetirement,
  DesktopRegistrationTakeover,
  InstallServiceOptions,
  RestartStop,
  ServiceController,
  ServiceStatus,
  UninstallServiceOptions,
} from "../index";
import {
  isServiceMutationAuthorityError,
  verifyServiceMutationAuthority,
} from "../mutation-authority";
import { markRegistrationCommitted } from "../cli-invocation-record";

// macOS service controller - CLI-owned launchctl.
// There is intentionally no `SMAppService` path here (Decision 1 of the Tech Plan); the CLI is the only owner of the host's lifecycle, and Desktop drives it via subprocess calls.

// Pluggable runner so tests can stub launchctl behaviour without spawning a real subprocess.
// Production callers leave it `undefined` and we fall back to the real `runCommand`.
export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

// Only the versioned maintenance-lease endpoint may bind a service mutation to another user's GUI launchd domain.
// AsyncLocalStorage makes the binding request-scoped, so an ambient environment variable or a parallel command cannot retarget an ordinary CLI service action to `gui/<other uid>`.
const maintenanceServiceUid = new AsyncLocalStorage<number>();

export async function withMacosMaintenanceServiceUid<T>(
  serviceUid: number,
  run: () => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(serviceUid) || serviceUid < 0) {
    throw new Error("maintenance service uid was invalid");
  }
  return maintenanceServiceUid.run(serviceUid, run);
}

export function createMacosController(
  runner: ProcessRunner | null,
): ServiceController {
  const unverifiedRun: ProcessRunner = runner ?? runCommand;
  const run: ProcessRunner = async (command, args, options) => {
    await verifyServiceMutationAuthority();
    return unverifiedRun(command, args, options);
  };
  return {
    install: (options) => installService(options, run),
    uninstall: (options) => uninstallService(options, run),
    status: (label) => statusService(label, run),
    stop: (label, options) => stopService(label, run, options.force, "stop"),
    start: (label) => startService(label, run),
    restart: (label) => restartService(label, run),
    hostStartAdoptionLabel: async (label) => {
      const desktopAgent = await probeDesktopAgentOwnership(label, run);
      return desktopAgent?.agentLabelId ?? label.id;
    },
    stopForRestart: (label, options) =>
      stopServiceForRestart(label, run, options.force),
    relaunchAfterRestart: (label, stop) =>
      relaunchServiceAfterRestart(label, stop, run),
    retireCompetingRegistration: (label) =>
      retireCompetingRegistration(label, run),
    takeoverDesktopRegistration: (label) =>
      takeoverDesktopRegistration(label, run),
  };
}

// `service install --takeover`: explicit-consent move of host management from the Desktop app to the CLI.
// The three-step contract: 1.
async function takeoverDesktopRegistration(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<DesktopRegistrationTakeover> {
  const guiTarget = guiDomain();
  // Pre-split machines: the CLI label itself is Desktop's SMAppService
  // registration. Booting THAT out corrupts the BTM state the app manages.
  const cliOwnership = await inspectLaunchdOwnership(
    `${guiTarget}/${label.id}`,
    run,
  ).catch((): LaunchdOwnership => ({ kind: "not-loaded" }));
  if (cliOwnership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install --takeover: label '${label.id}' is Desktop's own SMAppService registration (pre-label-split machine, loaded from ${cliOwnership.path}); takeover cannot bootout this label without corrupting the login-item state the app manages. Run 'traycer host service uninstall', then re-run 'traycer host service install'.`,
      details: { label: label.id, loadedPath: cliOwnership.path },
      exitCode: 1,
    });
  }
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  if (desktopAgent === null) return { kind: "not-applicable" };
  // The CLI is taking this label over; Desktop's registration is retired, not
  // relaunched. Nothing is coming back under this identity.
  const outcome = await requestCooperativeShutdown(
    label.environment,
    "takeover",
    "shutdown",
  );
  if (outcome.kind === "busy") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_BUSY,
      message:
        "service install --takeover: the running host has work in progress and denied the shutdown claim; retry once the work completes.",
      details: { label: label.id, agentLabel: desktopAgent.agentLabelId },
      exitCode: 1,
    });
  }
  const logger = createCliLogger(label.environment);
  if (
    outcome.kind === "unreachable" ||
    outcome.kind === "hung" ||
    outcome.kind === "no-metadata"
  ) {
    logger.warn(
      "Takeover: the Desktop-managed host could not be stopped cooperatively; booting the job out underneath it.",
      {
        label: label.id,
        agentLabel: desktopAgent.agentLabelId,
        cause:
          outcome.kind === "unreachable"
            ? outcome.cause
            : outcome.kind === "hung"
              ? `pid ${outcome.pid} outlived the shutdown grace`
              : "pid metadata is missing or unreadable, so no endpoint could be asked",
      },
    );
  }
  const agentTarget = `${guiTarget}/${desktopAgent.agentLabelId}`;
  // `--wait` is load-bearing: return only after the evicted process has actually exited.
  await run("launchctl", ["bootout", "--wait", agentTarget], {
    env: undefined,
    cwd: undefined,
    timeoutMs: STOP_EXIT_TIMEOUT_MS,
    tolerateNonZeroExit: true,
  });
  // Verification must be POSITIVE.
  // `inspectLaunchdOwnership` collapses every non-zero exit - and its caller every thrown error - into `not-loaded`, so an EPERM, a timeout, or a launchctl that could not spawn would all have read as "the bootout worked".
  const postBootout = await verifyAgentBootedOut(agentTarget, run);
  if (postBootout !== "absent") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message:
        postBootout === "still-loaded"
          ? `service install --takeover: launchctl bootout of '${desktopAgent.agentLabelId}' did not take effect (the agent is still loaded). Use the Traycer app to remove the host, or run 'traycer host service uninstall'.`
          : `service install --takeover: could not confirm that '${desktopAgent.agentLabelId}' was booted out (launchctl did not answer), so the takeover was stopped rather than risk running two hosts. Re-run the command, or use the Traycer app to remove the host, or run 'traycer host service uninstall'.`,
      details: {
        label: label.id,
        agentLabel: desktopAgent.agentLabelId,
        verification: postBootout,
      },
      exitCode: 1,
    });
  }
  logger.info(
    "Takeover: booted out Traycer Desktop's SMAppService agent; the CLI now owns host registration. Launching the Desktop app again may re-register its agent - uninstall or update the app to make the takeover permanent.",
    {
      label: label.id,
      agentLabel: desktopAgent.agentLabelId,
      loadedPath: desktopAgent.loadedPath,
    },
  );
  return {
    kind: "took-over",
    agentLabelId: desktopAgent.agentLabelId,
    cooperativeStop:
      outcome.kind === "stopped"
        ? "stopped"
        : outcome.kind === "no-host"
          ? "no-host"
          : "skipped-unreachable",
  };
}

async function installService(
  options: InstallServiceOptions,
  run: ProcessRunner,
): Promise<void> {
  // Register the host by writing a user-domain LaunchAgent plist: `RunAtLoad` makes it auto-start at login and surface in System Settings → Login Items / "Allow in the Background" (that BTM row is driven by the registration itself, not by `ProcessType`).
  // `ProcessType: Interactive` is the only band that runs "with the same resource limitations as apps, that is to say, none" (launchd.plist(5)) - the host does latency-sensitive RPC work and being CPU/IO-throttled (and pinned to efficiency cores on Apple Silicon) starved the event loop on open.
  const guiTarget = guiDomain();
  const serviceTarget = `${guiTarget}/${options.label.id}`;
  // Refuse to take over a label Desktop already owns via SMAppService.
  // A stale `~/Library/LaunchAgents/<label>.plist` can coexist with an in-bundle SMAppService load of the same label; bootout/bootstrap of the raw path would corrupt BTM / CDHash state that Desktop manages.
  const ownership = await inspectLaunchdOwnership(serviceTarget, run);
  if (ownership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install: label '${options.label.id}' is owned by SMAppService (loaded from ${ownership.path}); the CLI must not bootout/bootstrap this label. If the Desktop-managed host is broken, run 'traycer host service uninstall' to remove its registration and re-run this command; otherwise relaunch the Traycer app to let it repair its own host.`,
      details: {
        label: options.label.id,
        loadedPath: ownership.path,
      },
      exitCode: 1,
    });
  }
  // Same refusal for the label-split world: post-split Desktop builds register `<label>.agent` via SMAppService and leave the CLI label unloaded.
  // Without this probe, a manual `service install` beside a desktop-owned agent would silently bootstrap a SECOND host under the CLI label - two hosts racing over the same pid metadata and stores.
  const agentLabelId = smAppServiceAgentLabelId(options.label);
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiTarget}/${agentLabelId}`,
    run,
  );
  if (agentOwnership.kind === "smappservice") {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: `service install: Traycer Desktop owns host registration on this machine (SMAppService agent '${agentLabelId}' loaded from ${agentOwnership.path}); installing the raw '${options.label.id}' LaunchAgent would run a second host beside it. If you only need the host running again, run 'traycer host restart' (it starts the Desktop-managed host). To move host management to the CLI instead, re-run with --takeover (the running host is stopped cooperatively first), or relaunch the Traycer app to let it repair its own host.`,
      details: {
        label: options.label.id,
        agentLabel: agentLabelId,
        loadedPath: agentOwnership.path,
      },
      exitCode: 1,
    });
  }
  // The launcher file must exist (and be executable) before the plist that points at it is bootstrapped - launchd spawns `ProgramArguments[0]` directly.
  // `chmod` runs unconditionally after the write because `writeFile`'s `mode` only applies when the file is created, not when an existing launcher is rewritten.
  const launcherPath = serviceLauncherScriptPath(options.label);
  await verifyServiceMutationAuthority();
  await mkdir(dirname(launcherPath), { recursive: true });
  await verifyServiceMutationAuthority();
  await writeFile(
    launcherPath,
    buildHostStartLauncherScript(options.label.id),
    "utf8",
  );
  await verifyServiceMutationAuthority();
  await chmod(launcherPath, 0o755);
  const manifestPath = serviceManifestPath(options.label);
  await verifyServiceMutationAuthority();
  await mkdir(dirname(manifestPath), { recursive: true });
  await verifyServiceMutationAuthority();
  await writeFile(
    manifestPath,
    buildPlist({ label: options.label, cli: options.cli }),
    "utf8",
  );
  // Only `bootout` when a job is actually loaded; `bootstrap` of a loaded job fails.
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
  // `bootstrap` loads the agent into launchd; plain `kickstart` (NOT `kickstart -k`) then ensures it is running.
  // We deliberately avoid `-k`: the plist sets `ThrottleInterval: 10`, so force-killing a healthy host would make launchd block the respawn ~10s.
  try {
    await run("launchctl", ["bootstrap", guiTarget, manifestPath], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    if (!isBenignBootstrapFailure(cause)) {
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        message: `launchctl bootstrap failed for ${options.label.id}: ${describeCause(cause)}`,
        details: { label: options.label.id, cause: describeCause(cause) },
        exitCode: 1,
      });
    }
    // Already-loaded after our probe/bootout means another process re-bootstrapped (or bootout did not fully clear) between steps.
    // Kickstart would only run the *cached* definition and leave the regenerated SoftResourceLimits / ProgramArguments inactive - so retry a full reload against the on-disk plist instead.
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
      // 30s, not 10s: the dev wrapper at ~/.traycer/cli/dev/bin/traycer exec's `bun src/index.ts` - bun cold-start across ~2500 TS files plus the host's first-boot work can comfortably exceed 10s on a loaded laptop.
      timeoutMs: 30_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    // Post-registration: `bootstrap` succeeded, so launchd holds a `RunAtLoad` registration and may already be launching the supervisor.
    // A caller holding a host-start adoption lease must honour it before surfacing this (`didServiceRegistrationCommit`), or the child launchd is bringing up is refused and the registered service is left hostless.
    if (isServiceMutationAuthorityError(cause)) {
      throw markRegistrationCommitted(cause);
    }
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart failed for ${options.label.id}: ${describeCause(cause)}`,
      details: {
        label: options.label.id,
        cause: describeCause(cause),
        registrationCommitted: true,
      },
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
// Used when bootstrap reports "already loaded" after we already wrote a new plist - kickstart alone does not apply that file.
async function reloadRegisteredService(
  options: ReloadRegisteredServiceOptions,
): Promise<void> {
  // The competing registrar that won the race this reload exists to fix may be Desktop's SMAppService, not another CLI process - re-probe ownership right before mutating.
  // Booting out an SMAppService-owned job would corrupt the BTM state Desktop manages, exactly what `installService`'s own upfront refusal exists to prevent.
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
    if (isServiceMutationAuthorityError(cause)) throw cause;
    // Race may have cleared the job between the failed bootstrap and this bootout; treat "not loaded" as success and continue to bootstrap the fresh file.
    // Real bootout failures must surface.
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
    if (isServiceMutationAuthorityError(cause)) throw cause;
    // A second "already loaded" after our own explicit bootout means a concurrent registrar won the reload race - and it bootstrapped the same freshly regenerated on-disk plist this process just wrote (every path that bootstraps this label rewrites the manifest first).
    // The loaded definition is therefore current, not the stale pre-rewrite cache this reload exists to evict: treat it as success and let the caller's kickstart run the winner's definition.
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
    // A genuine second-bootstrap failure leaves the label fully deregistered (the bootout above already succeeded) - launchd has no atomic reload, so this window is inherent.
    // Fail closed with the explicit error rather than kickstart a definition we know is gone.
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
// Desktop .app builds register the same reverse-DNS label via SMAppService against the *in-bundle* LaunchAgent (`<App>.app/Contents/Library/LaunchAgents/<label>.plist`).
type LaunchdOwnership =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "smappservice"; readonly path: string }
  | { readonly kind: "cli-or-other"; readonly path: string | null };

// Probe launchd for who currently owns this label.
// `launchctl print` exits 0 when loaded; non-zero means not loaded.
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
  return classifyLaunchdPrintOutput(`${result.stdout}\n${result.stderr}`);
}

/** Ownership from `launchctl print`. Blindness to current macOS format shipped dual registrations. */
function classifyLaunchdPrintOutput(printOutput: string): LaunchdOwnership {
  const fields = parseLaunchctlPrintFields(printOutput);
  const path = fields.get("path") ?? null;
  const isServiceManagement =
    fields.get("managed_by") === SERVICE_MANAGEMENT_MANAGED_BY ||
    fields.get("type") === SERVICE_MANAGEMENT_JOB_TYPE ||
    (path !== null && isSmAppServiceLaunchAgentPath(path));
  if (isServiceManagement) {
    return { kind: "smappservice", path: path ?? SMAPPSERVICE_PATH_UNKNOWN };
  }
  return { kind: "cli-or-other", path };
}

// launchctl returns "Service is already loaded" / "Bootstrap failed: 37: ...
// (already loaded)" when the agent is already registered.
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
  // Deliberate asymmetry with `installService`'s SMAppService refusal: the refusal exists because bootout + bootstrap of the RAW plist would corrupt / dual-register the BTM state Desktop manages.
  // Uninstall only removes - bootout is the strongest teardown the CLI has (and on macOS 26+ it is exactly what flushes the BTM entry), and refusing here would strand users whose .app is already gone with an un-removable agent.
  const ownership = await inspectLaunchdOwnership(serviceTarget, run).catch(
    (): LaunchdOwnership => ({ kind: "not-loaded" }),
  );
  if (ownership.kind === "smappservice") {
    createCliLogger(options.label.environment).warn(
      "Service uninstall: label is registered by Traycer Desktop's login item (SMAppService); booting it out now, but macOS may keep the login-item record. If the host reappears at next login, remove Traycer in the Desktop app or System Settings -> Login Items.",
      { label: options.label.id, loadedPath: ownership.path },
    );
  }
  // Post-label-split Desktop builds run the host under `<label>.agent`; tear that job down too (agent first - it is the live one on such machines) so `host uninstall --all` doesn't leave a running host pointed at the install dir being removed.
  // Same BTM-record caveat as the CLI-label bootout above.
  const agentLabelId = smAppServiceAgentLabelId(options.label);
  const agentTarget = `${guiDomain()}/${agentLabelId}`;
  let agentOwnership: LaunchdOwnership;
  try {
    agentOwnership = await inspectLaunchdOwnership(agentTarget, run);
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    agentOwnership = { kind: "not-loaded" };
  }
  if (agentOwnership.kind === "smappservice") {
    createCliLogger(options.label.environment).warn(
      "Service uninstall: Traycer Desktop's SMAppService agent is registered for this environment; booting it out now, but macOS may keep the login-item record. If the host reappears at next login, remove Traycer in the Desktop app or System Settings -> Login Items.",
      { label: agentLabelId, loadedPath: agentOwnership.path },
    );
  }
  // Attempt both targets even when one fails hard: a hard failure on the agent label (iterated first, since it's the live job on migrated machines) must not skip the CLI-label bootout - `host uninstall --all` promises best-effort-per-target cleanup, not "stop at the first failure".
  // The manifest `rm` below stays gated on BOTH attempts being clean (success or benign not-loaded): `statusService` treats a missing manifest as "not-installed", so deleting it after a genuinely failed bootout would misreport a still-loaded job as gone.
  const bootoutFailures: Array<{ labelId: string; cause: unknown }> = [];
  for (const [labelId, target] of [
    [agentLabelId, agentTarget],
    [options.label.id, serviceTarget],
  ] as const) {
    try {
      await run("launchctl", ["bootout", "--wait", target], {
        env: undefined,
        cwd: undefined,
        // `--wait` is launchd's authoritative completion barrier but may block indefinitely.
        // Keep the subprocess bound above the host's own forced shutdown watchdog so normal graceful shutdown has time to finish.
        timeoutMs: STOP_EXIT_TIMEOUT_MS,
        tolerateNonZeroExit: false,
      });
    } catch (cause) {
      if (isServiceMutationAuthorityError(cause)) throw cause;
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
  await verifyServiceMutationAuthority();
  await rm(serviceManifestPath(options.label), { force: true });
  // The launcher directory is per-label and exists solely for the plist
  // that was just removed.
  await verifyServiceMutationAuthority();
  await rm(dirname(serviceLauncherScriptPath(options.label)), {
    recursive: true,
    force: true,
  });
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
  // SMAppService-owned loads of this label are not CLI-managed, even when a stale raw LaunchAgents plist still exists on disk from a prior CLI-managed install.
  // Reporting the dedicated `externally-managed` state (NOT `not-installed`) does two things at once: install-lifecycle / provisioning still stay away from the reload path (stop + bootout/bootstrap) against Desktop's BTM registration, and auto-bootstrap / doctor see that a registration exists - `not-installed` here used to make every `traycer login` on a Desktop-managed machine select "service repair" and run straight into `installService`'s SMAppService refusal.
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
  // Post-label-split Desktop builds register `<label>.agent` and leave the CLI label unloaded with its raw manifest deleted - without this probe such a machine reads `not-installed` and doctor/auto-bootstrap route into `installService`'s agent-label refusal instead of recognizing the healthy Desktop-owned registration.
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

// Grace window for the host process to actually exit after SIGTERM.
// In normal operation graceful shutdown completes in milliseconds, so the poll below resolves almost immediately.
const STOP_EXIT_TIMEOUT_MS = SHUTDOWN_FORCE_EXIT_MS + STOP_EXIT_GRACE_MARGIN_MS;
const STOP_EXIT_POLL_MS = 150;

// Who owns the host on this machine: Traycer Desktop's post-label-split SMAppService agent, or nobody but the CLI.
// Ownership routes the operation, it never refuses it.
type DesktopAgentOwnership = {
  readonly agentLabelId: string;
  readonly loadedPath: string;
};

async function probeDesktopAgentOwnership(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<DesktopAgentOwnership | null> {
  const agentLabelId = smAppServiceAgentLabelId(label);
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiDomain()}/${agentLabelId}`,
    run,
  ).catch((cause: unknown): LaunchdOwnership => {
    // Advisory means tolerant of launchctl faults, not of a revoked mutation capability: reporting "no Desktop agent" for an authority failure would route adoption to the logical label and publish a grant the Desktop supervisor rejects.
    // Same re-throw discipline as every other probe here.
    if (isServiceMutationAuthorityError(cause)) throw cause;
    return { kind: "not-loaded" };
  });
  if (agentOwnership.kind !== "smappservice") return null;
  return { agentLabelId, loadedPath: agentOwnership.path };
}

// `host stop` on a Desktop-managed machine: cooperative or not at all.
// A plain SIGTERM is not available (launchd would respawn under Desktop's KeepAlive policy and the CLI label's job does not exist), and a bootout would mutate the registration Desktop owns - so the only *stop* the CLI can honestly offer is asking the host to stand down, and naming the takeover escape hatch when the host cannot be asked.
async function stopDesktopManagedHost(
  label: ServiceLabel,
  agent: DesktopAgentOwnership,
  force: boolean,
): Promise<void> {
  if (force) {
    await forceStopDesktopManagedHost(label, agent);
    return;
  }
  const outcome = await requestCooperativeShutdown(
    label.environment,
    "stop",
    "shutdown",
  );
  switch (outcome.kind) {
    case "stopped":
    case "no-host":
      return;
    case "no-metadata":
      // Nothing published an endpoint, so there is nothing this command can ask to stand down - and no launchd mutation the CLI may perform on a registration Desktop owns.
      // Reporting success would be a lie if a host is mid-boot, so say exactly what is known.
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop: no host endpoint is published for '${label.id}' (pid metadata is missing or unreadable), so the running host - if any - cannot be asked to stand down. If the host is starting, retry in a moment; if it is wedged, run 'traycer host service uninstall' and relaunch the Traycer app, or take over with 'traycer host service install --takeover'.`,
        details: { label: label.id, agentLabel: agent.agentLabelId },
        exitCode: 1,
      });
    case "busy":
      throw cliError({
        code: CLI_ERROR_CODES.HOST_BUSY,
        message:
          "host stop: the running host has work in progress and denied the shutdown claim; retry once the work completes, or re-run with --force to stop it anyway (running terminal sessions and in-flight agent work will be killed).",
        details: { label: label.id, agentLabel: agent.agentLabelId },
        exitCode: 1,
      });
    case "hung":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop: the host acknowledged the shutdown claim but pid=${outcome.pid} did not exit within the shutdown grace; stop did not take effect.`,
        details: {
          label: label.id,
          agentLabel: agent.agentLabelId,
          pid: outcome.pid,
        },
        exitCode: 1,
      });
    case "unreachable":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop: Traycer Desktop owns host registration on this machine (SMAppService agent '${agent.agentLabelId}' loaded from ${agent.loadedPath}) and the running host's RPC endpoint is unreachable (${outcome.cause}); stopping it from the CLI would deregister Desktop's agent. Use the Traycer app to stop it, or take over management with 'traycer host service uninstall' followed by 'traycer host service install', then retry.`,
        details: {
          label: label.id,
          agentLabel: agent.agentLabelId,
          loadedPath: agent.loadedPath,
          cause: outcome.cause,
        },
        exitCode: 1,
      });
  }
}

// `host stop --force` on a Desktop-managed machine: kill the host child directly.
// This mutates NO launchd registration - the SMAppService agent stays exactly as Desktop left it - and the stop-intent record (written by `withStopIntent` before any controller stop runs) tells the supervisor the death was asked for, so nothing relaunches the host.
async function forceStopDesktopManagedHost(
  label: ServiceLabel,
  agent: DesktopAgentOwnership,
): Promise<void> {
  const outcome = await forceStopHostProcess(label.environment, "stop");
  switch (outcome.kind) {
    case "stopped":
    case "no-host":
      return;
    case "no-metadata":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop --force: no host endpoint is published for '${label.id}' (pid metadata is missing or unreadable), so there is no process to kill. If the host is starting, retry in a moment; if it is wedged, run 'traycer host service uninstall' and relaunch the Traycer app.`,
        details: { label: label.id, agentLabel: agent.agentLabelId },
        exitCode: 1,
      });
    case "identity-unverified":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop --force: could not verify that pid=${outcome.pid} is still the host process pid.json describes (the pid may have been recycled), so refusing to signal it. Retry in a moment; if the host is wedged, run 'traycer host service uninstall' and relaunch the Traycer app.`,
        details: {
          label: label.id,
          agentLabel: agent.agentLabelId,
          pid: outcome.pid,
        },
        exitCode: 1,
      });
    case "hung":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host stop --force: pid=${outcome.pid} survived SIGKILL through the exit grace; stop did not take effect.`,
        details: {
          label: label.id,
          agentLabel: agent.agentLabelId,
          pid: outcome.pid,
        },
        exitCode: 1,
      });
  }
}

// `host restart` on a Desktop-managed machine.
// Cooperative stop first (a busy host denies and the denial is surfaced - never escalate over live work); then relaunch via kickstart of the agent label.
async function restartDesktopManagedHost(
  label: ServiceLabel,
  agent: DesktopAgentOwnership,
  run: ProcessRunner,
): Promise<void> {
  const stop = await standDownDesktopManagedHost(label, agent, false);
  await kickstartDesktopAgent(agent, stop.forcedRecycle, run);
}

// The stop half of a Desktop-managed restart.
// Unlike `stopDesktopManagedHost` a host that cannot be asked to stand down is NOT terminal here: the caller is going to relaunch the job either way, so the inability to ask is reported as `forcedRecycle` instead of throwing.
async function standDownDesktopManagedHost(
  label: ServiceLabel,
  agent: DesktopAgentOwnership,
  force: boolean,
): Promise<RestartStop> {
  if (force) {
    // Every force outcome relaunches by RECYCLING the job: the child was killed (or could not be found, or could not be verified as ours), the supervisor may still be winding down, and `kickstart -k` is correct in every one of those states where a plain kickstart can silently no-op.
    // A `hung`/`no-metadata`/`identity-unverified` outcome is not terminal here for the same reason the cooperative path's unreachable outcome is not: the caller is about to recycle the job either way, and the recycle kills the JOB's own process as launchd tracks it - never a pid.json pid - so it is safe even when pid.json is stale.
    await forceStopHostProcess(label.environment, "restart");
    return { forcedRecycle: true };
  }
  // The stop half of a restart: this caller relaunches the job immediately afterwards, so the host may publish its restart tombstone and spare every attached client the death-then-recovery bounce.
  const outcome = await requestCooperativeShutdown(
    label.environment,
    "restart",
    "restart",
  );
  if (outcome.kind === "busy") {
    throw cliError({
      code: CLI_ERROR_CODES.HOST_BUSY,
      message:
        "host restart: the running host has work in progress and denied the shutdown claim; retry once the work completes, or re-run with --force to restart anyway (running terminal sessions and in-flight agent work will be killed).",
      details: { label: label.id, agentLabel: agent.agentLabelId },
      exitCode: 1,
    });
  }
  return {
    forcedRecycle:
      outcome.kind === "unreachable" ||
      outcome.kind === "hung" ||
      // Unreadable metadata is not proof the host is gone, and a plain kickstart of a job launchd still considers running is a no-op - the restart would silently not happen.
      // Recycling is correct in both readings: it replaces a quietly-live host, and it starts one that really had exited.
      outcome.kind === "no-metadata",
  };
}

async function kickstartDesktopAgent(
  agent: DesktopAgentOwnership,
  forcedRecycle: boolean,
  run: ProcessRunner,
): Promise<void> {
  const target = `${guiDomain()}/${agent.agentLabelId}`;
  const args = forcedRecycle
    ? ["kickstart", "-k", target]
    : ["kickstart", target];
  try {
    await run("launchctl", args, {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl ${forcedRecycle ? "kickstart -k" : "kickstart"} failed for ${agent.agentLabelId}: ${describeCause(cause)}`,
      details: { label: agent.agentLabelId, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

// Whether the competing CLI manifest is there. `unreadable` is distinct from
// `absent` on purpose - see the probe in `retireCompetingRegistration`.
type ManifestProbe =
  | { readonly kind: "present" }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly cause: unknown };

/** Retire a competing CLI-label job only when the agent label is SMAppService-owned and the CLI label is not. Never throws. */
/** Post-bootout verification for `--takeover`, as three states rather than two. The shared classifier is what makes "gone" separable from "could not tell": it recognises launchctl's not-found output as `absent` and maps a permission error, a timeout, or a spawn failure to `indeterminate` - distinctions `inspectLaunchdOwnership` deliberately discards because for ownership questions an unreadable label is safely "not ours". */
async function verifyAgentBootedOut(
  agentTarget: string,
  run: ProcessRunner,
): Promise<"absent" | "still-loaded" | "indeterminate"> {
  const result = await run("launchctl", ["print", agentTarget], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  }).then(
    (value): ProbeCommandResult => ({
      exitCode: value.exitCode,
      stdout: value.stdout,
      stderr: value.stderr,
      timedOut: false,
      spawnFailed: false,
      signal: null,
    }),
    (): ProbeCommandResult => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnFailed: true,
      signal: null,
    }),
  );
  const probe = classifyLaunchctlPrintResult(result, null, null);
  switch (probe.kind) {
    case "absent":
      return "absent";
    case "observed":
      return "still-loaded";
    case "indeterminate":
      return "indeterminate";
  }
}

/** Positive-evidence wedge probe for the retirement gate, read from the agent's own `launchctl print` through the shared classifier. Only a POSITIVE `not-wedged` unlocks the destructive path: an indeterminate probe (spawn failure, timeout, permission) reports `unknown`, and callers must treat that like `wedged`. */
async function probeAgentWedge(
  agentTarget: string,
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<"wedged" | "not-wedged" | "unknown"> {
  const result = await run("launchctl", ["print", agentTarget], {
    env: undefined,
    cwd: undefined,
    timeoutMs: 10_000,
    tolerateNonZeroExit: true,
  }).then(
    (value): ProbeCommandResult => ({
      exitCode: value.exitCode,
      stdout: value.stdout,
      stderr: value.stderr,
      timedOut: false,
      spawnFailed: false,
      signal: null,
    }),
    (): ProbeCommandResult => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
      timedOut: false,
      spawnFailed: true,
      signal: null,
    }),
  );
  const verdict = deriveWedgeVerdict(
    classifyLaunchctlPrintResult(result, null, smAppServiceAgentLabelId(label)),
    {
      loginItemEnabled: null,
      hasPidMetadata: (await readHostPidMetadata(label.environment)) !== null,
      hasAttemptProgress: false,
    },
  );
  switch (verdict.kind) {
    case "wedged":
      return "wedged";
    case "healthy-or-unknown":
      return "not-wedged";
    case "indeterminate":
      return "unknown";
  }
}

async function retireCompetingRegistration(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<CompetingRegistrationRetirement> {
  const guiTarget = guiDomain();
  const agentLabelId = smAppServiceAgentLabelId(label);
  // The AGENT probe collapses failure into not-loaded on purpose: this whole repair is predicated on positive proof that Desktop owns registration, so anything short of that must bail out at `not-applicable`.
  // A repair must never be the thing that breaks a machine it could not inspect.
  const agentOwnership = await inspectLaunchdOwnership(
    `${guiTarget}/${agentLabelId}`,
    run,
  ).catch((): LaunchdOwnership => ({ kind: "not-loaded" }));
  if (agentOwnership.kind !== "smappservice") {
    return { kind: "not-applicable" };
  }
  // Desktop owning registration is NOT enough to justify deleting the CLI one.
  // If the agent is loaded but unspawnable (spawn failed / EX_CONFIG / stale LWCR), the CLI registration below may be the only host this machine can actually run - including one deliberately created by `service install --takeover`.
  const agentWedge = await probeAgentWedge(
    `${guiTarget}/${agentLabelId}`,
    label,
    run,
  );
  if (agentWedge !== "not-wedged") {
    createCliLogger(label.environment).warn(
      "Service repair: the Traycer Desktop agent may not be spawnable, so the competing CLI registration was kept - it may be the only host that starts on this machine.",
      { label: label.id, agentLabel: agentLabelId, probe: agentWedge },
    );
    return { kind: "kept-agent-possibly-wedged", probe: agentWedge };
  }
  const serviceTarget = `${guiTarget}/${label.id}`;
  // The CLI-label probe canNOT be collapsed the same way.
  // `null` is a fourth state - "we could not read who owns this label" - and it has to stay distinct from not-loaded in BOTH directions: folding it into not-loaded would let an unprobeable machine report `nothing-to-retire` ("already clean") or `retired` while a competing host is still running.
  const ownership = await inspectLaunchdOwnership(serviceTarget, run).catch(
    (): LaunchdOwnership | null => null,
  );
  if (ownership !== null && ownership.kind === "smappservice") {
    return { kind: "not-applicable" };
  }
  const manifestPath = serviceManifestPath(label);
  // `fileExists` swallows only ENOENT and rethrows the rest, so an unreadable `~/Library/LaunchAgents` would escape the never-throws contract above.
  // It is kept as a THIRD state rather than folded into "absent": absent means "this machine is already clean", and reporting an unreadable manifest that way would hide a login-time relapse behind `nothing-to-retire` - the same conflation the summary below refuses to make for a failed bootout.
  const manifestProbe: ManifestProbe = await fileExists(manifestPath).then(
    (exists): ManifestProbe =>
      exists ? { kind: "present" } : { kind: "absent" },
    (cause: unknown): ManifestProbe => ({ kind: "unreadable", cause }),
  );
  if (
    ownership !== null &&
    ownership.kind === "not-loaded" &&
    manifestProbe.kind === "absent"
  ) {
    return { kind: "nothing-to-retire" };
  }
  const logger = createCliLogger(label.environment);
  let bootedOut = false;
  let bootoutFailed = false;
  // Attempted and not confirmed - distinct from `bootoutFailed`, which is also set below when NO bootout runs.
  // The record decorator reads this as "the registration may be gone" (see `CompetingRegistrationRetirement`).
  let bootoutIndeterminate = false;
  if (ownership === null) {
    // Deliberately no bootout on an unknown owner.
    // The one thing that would make eviction catastrophic here is the CLI label BEING Desktop's pre-split SMAppService registration - bootout/manifest-removal against that corrupts the BTM state Desktop manages - and identifying it is precisely what the failed probe could not do.
    bootoutFailed = true;
    logger.warn(
      "Service repair: could not read who owns the competing CLI label, so it was not evicted; if the host is unreachable, open Traycer or log out and back in.",
      { label: label.id, agentLabel: agentLabelId },
    );
  } else if (ownership.kind !== "not-loaded") {
    try {
      // `--wait` is load-bearing, not tidiness: a bare bootout returns when launchd ACCEPTS the request, not when the process is gone, and the agent we start below runs `findLiveIncumbentHost` as its very first act.
      // The evicted host publishes `pid.json` until the very end of its teardown (the RPC handle closes last, after adapter/child-server and store shutdown, budgeted at `SHUTDOWN_FORCE_EXIT_MS`), so without this barrier the new agent would routinely see the corpse as a live incumbent, decline, and exit 0 - which `KeepAlive{SuccessfulExit: false}` leaves DOWN until the next login.
      await run("launchctl", ["bootout", "--wait", serviceTarget], {
        env: undefined,
        cwd: undefined,
        timeoutMs: STOP_EXIT_TIMEOUT_MS,
        tolerateNonZeroExit: false,
      });
      bootedOut = true;
    } catch (cause) {
      if (isServiceMutationAuthorityError(cause)) throw cause;
      // A benign failure means the job was already gone - nothing was
      // evicted, but nothing failed either.
      if (!isBenignBootoutFailure(cause)) {
        bootoutFailed = true;
        // Indeterminate only if `launchctl` may have RUN.
        // A spawn failure (`ProcessSpawnError`: the binary could not be started at all) is the one failure that proves the request never reached launchd, so the registration is provably untouched and the record decorator must not invalidate for it.
        bootoutIndeterminate = !(cause instanceof ProcessSpawnError);
        // Deliberately does NOT claim the competing host is still running.
        // With `--wait` the likeliest way here is the timeout, and the timeout kills `launchctl` - the waiter - not the job: launchd already accepted the bootout, so the host is probably gone or going.
        logger.warn(
          "Service repair: could not confirm the competing CLI-label host was evicted; if the host is unreachable, open Traycer or log out and back in.",
          {
            label: label.id,
            agentLabel: agentLabelId,
            cause: describeCause(cause),
          },
        );
      }
    }
  }
  if (bootedOut) {
    // Logged unconditionally, and BEFORE any later step can fail us out of this function: evicting a host the user was using is the single most consequential thing this repair does, and "my host went away after an install" is diagnosed from this log.
    // A partially-failed repair returns early below, so recording the eviction only in the success line would hide exactly the case worth reading about.
    logger.info(
      "Service repair: evicted the competing CLI-label host - Traycer Desktop's SMAppService agent owns the host on this machine.",
      { label: label.id, agentLabel: agentLabelId },
    );
  }
  // The manifest removal is local, instantaneous and the durable half of the repair ("does not come back at the next login"), so it runs before the kickstart rather than behind a subprocess that can burn its timeout.
  let manifestRemoved = false;
  let manifestRemovalFailed = false;
  if (manifestProbe.kind === "unreadable") {
    // No `rm` attempt: `rm(force)` cannot distinguish "removed" from "was never there", so on a path we could not even stat it would report a durable half that may not have happened.
    // Counting it as a removal failure is the honest reading - for all we know the manifest is still there.
    manifestRemovalFailed = true;
    logger.warn(
      "Service repair: could not read the competing CLI LaunchAgent manifest, so it was not removed; if one is present it will start a second host at the next login.",
      {
        label: label.id,
        manifestPath,
        cause: describeCause(manifestProbe.cause),
      },
    );
  } else if (manifestProbe.kind === "present") {
    try {
      await verifyServiceMutationAuthority();
      await rm(manifestPath, { force: true });
      manifestRemoved = true;
    } catch (cause) {
      if (isServiceMutationAuthorityError(cause)) throw cause;
      manifestRemovalFailed = true;
      logger.warn(
        "Service repair: failed to remove the competing CLI LaunchAgent manifest; it will start a second host at the next login.",
        { label: label.id, manifestPath, cause: describeCause(cause) },
      );
    }
  }
  // ONLY after an eviction actually happened.
  // A failed bootout means the competing host is still running, and starting the agent beside it would manufacture the very dual-host state this repair removes.
  let agentStartRequested = false;
  if (bootedOut) {
    try {
      await run("launchctl", ["kickstart", `${guiTarget}/${agentLabelId}`], {
        env: undefined,
        cwd: undefined,
        timeoutMs: 10_000,
        tolerateNonZeroExit: false,
      });
      agentStartRequested = true;
    } catch (cause) {
      if (isServiceMutationAuthorityError(cause)) throw cause;
      logger.warn(
        "Service repair: evicted the competing CLI-label host but could not start Traycer Desktop's agent; open Traycer or log out and back in if the host is unreachable.",
        {
          label: label.id,
          agentLabel: agentLabelId,
          cause: describeCause(cause),
        },
      );
    }
  }
  // A hard failure must never read as `nothing-to-retire`.
  // That value means "this machine is already clean", and conflating the two hides a repair that did not happen - reachable whenever the job is loaded but the manifest is already gone, which is now a NORMAL steady state because Desktop's launch repair removes manifests without booting out.
  if (bootoutFailed || manifestRemovalFailed) {
    return {
      kind: "retire-failed",
      bootoutFailed,
      manifestRemovalFailed,
      bootedOut,
      bootoutIndeterminate,
      manifestRemoved,
    };
  }
  if (!bootedOut && !manifestRemoved) {
    return { kind: "nothing-to-retire" };
  }
  logger.info("Service repair: retired the competing CLI registration.", {
    label: label.id,
    agentLabel: agentLabelId,
    bootedOut,
    manifestRemoved,
    agentStartRequested,
  });
  return { kind: "retired", bootedOut, manifestRemoved, agentStartRequested };
}

async function stopService(
  label: ServiceLabel,
  run: ProcessRunner,
  force: boolean,
  operation: "stop" | "restart",
): Promise<void> {
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  if (desktopAgent !== null) {
    await stopDesktopManagedHost(label, desktopAgent, force);
    return;
  }
  if (force) {
    // Force takes the child-kill engine from the outset, not as an escalation after `bootout`.
    await forceStopCliOwnedHost(label, operation);
    return;
  }
  // Snapshot the live host pid BEFORE signalling so we can confirm the process truly exits.
  // `host restart` does stop→start: if `start`'s kickstart fires while the old process is still winding down, launchd sees the job as already-running and the kickstart no-ops - leaving the host DOWN after a "restart" (and `host stop` reporting success while the host keeps serving).
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
  // The whole point of waiting is that `host stop`/`restart` only take effect once the old process is gone (a `start` kickstart no-ops while launchd still sees the job running).
  // A timeout means the host is still serving, so surface it as a failure instead of reporting success on a no-op stop.
  if (!exited) {
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `host (pid=${before.pid}) did not exit within ${STOP_EXIT_TIMEOUT_MS}ms of SIGTERM; stop did not take effect. Re-run with --force to escalate to SIGKILL.`,
      details: {
        label: label.id,
        pid: before.pid,
        timeoutMs: STOP_EXIT_TIMEOUT_MS,
      },
      exitCode: 1,
    });
  }
}

// Outcome mapping for the CLI-owned force escalation.
// Mirrors `forceStopDesktopManagedHost` - same engine, same terminal outcomes - with CLI-owned remediation in the messages (this machine has no Desktop-owned registration to relaunch; the wedge escape is service uninstall/install).
async function forceStopCliOwnedHost(
  label: ServiceLabel,
  operation: "stop" | "restart",
): Promise<void> {
  const outcome = await forceStopHostProcess(label.environment, operation);
  switch (outcome.kind) {
    case "stopped":
    case "no-host":
      return;
    case "no-metadata":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host ${operation} --force: no host endpoint is published for '${label.id}' (pid metadata is missing or unreadable), so there is no process to kill. If the host is starting, retry in a moment; if it is wedged, run 'traycer host service uninstall' and then 'traycer host service install'.`,
        details: { label: label.id },
        exitCode: 1,
      });
    case "identity-unverified":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host ${operation} --force: could not verify that pid=${outcome.pid} is still the host process pid.json describes (the pid may have been recycled), so refusing to signal it. Retry in a moment; if the host is wedged, run 'traycer host service uninstall' and then 'traycer host service install'.`,
        details: { label: label.id, pid: outcome.pid },
        exitCode: 1,
      });
    case "hung":
      throw cliError({
        code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
        message: `host ${operation} --force: pid=${outcome.pid} survived SIGKILL through the exit grace; the stop did not take effect.`,
        details: { label: label.id, pid: outcome.pid },
        exitCode: 1,
      });
  }
}

// Poll until `pid` is no longer alive or the deadline passes.
// Returns `true` once the process is observed gone, `false` if it is still alive at the deadline (the caller decides whether that is a hard failure).
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
  // On a Desktop-managed machine the CLI label has no job; the agent label is the one launchd can start.
  // Kickstart of an already-loaded job mutates no registration, so this is safe on both worlds.
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  const targetLabelId =
    desktopAgent === null ? label.id : desktopAgent.agentLabelId;
  try {
    await run("launchctl", ["kickstart", `${guiDomain()}/${targetLabelId}`], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart failed for ${targetLabelId}: ${describeCause(cause)}`,
      details: { label: targetLabelId, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

// `host restart`'s stop half.
// On a Desktop-managed machine an unreachable or hung host reports `forcedRecycle` instead of throwing, so the command reaches its relaunch - that is the whole repair report 2 asked for.
async function stopServiceForRestart(
  label: ServiceLabel,
  run: ProcessRunner,
  force: boolean,
): Promise<RestartStop> {
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  if (desktopAgent !== null) {
    return await standDownDesktopManagedHost(label, desktopAgent, force);
  }
  // CLI-owned force-stop takes the child-kill engine from the outset, not as an escalation.
  await stopService(label, run, force, "restart");
  return { forcedRecycle: true };
}

async function relaunchServiceAfterRestart(
  label: ServiceLabel,
  stop: RestartStop,
  run: ProcessRunner,
): Promise<void> {
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  if (desktopAgent !== null) {
    await kickstartDesktopAgent(desktopAgent, stop.forcedRecycle, run);
    return;
  }
  if (stop.forcedRecycle) {
    await restartService(label, run);
    return;
  }
  await startService(label, run);
}

async function restartService(
  label: ServiceLabel,
  run: ProcessRunner,
): Promise<void> {
  const desktopAgent = await probeDesktopAgentOwnership(label, run);
  if (desktopAgent !== null) {
    await restartDesktopManagedHost(label, desktopAgent, run);
    return;
  }
  try {
    await run("launchctl", ["kickstart", "-k", `${guiDomain()}/${label.id}`], {
      env: undefined,
      cwd: undefined,
      timeoutMs: 10_000,
      tolerateNonZeroExit: false,
    });
  } catch (cause) {
    if (isServiceMutationAuthorityError(cause)) throw cause;
    throw cliError({
      code: CLI_ERROR_CODES.SERVICE_CONTROL_FAILED,
      message: `launchctl kickstart -k failed for ${label.id}: ${describeCause(cause)}`,
      details: { label: label.id, cause: describeCause(cause) },
      exitCode: 1,
    });
  }
}

function guiDomain(): string {
  return `gui/${maintenanceServiceUid.getStore() ?? process.getuid?.() ?? 0}`;
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

// `AssociatedBundleIdentifiers` groups this raw LaunchAgent under the Traycer app in System Settings → Login Items (macOS 13+; older releases ignore the key).
// Without it, background-task management names the item after `ProgramArguments[0]` - literally "sh" from an "Unknown Developer", which reads as malware (field observation 2026-07-28: `sfltool dumpbtm` showed `Name: sh, Parent Identifier: Unknown Developer` for this agent, on every CLI-registered install - dev machines have no in-bundle SMAppService plist, so they ALWAYS take this path, as does the desktop's takeover fallback).
const DESKTOP_APP_BUNDLE_ID = "ai.traycer.desktop";

/** The PATH to bake into the host's LaunchAgent. launchd would otherwise give the host a bare PATH that can't see provider CLIs installed via nvm/Homebrew/asdf/etc. `host install` is normally invoked from the user's shell (e.g. */
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
  // `ProgramArguments[0]` is the launcher FILE, not `/bin/sh -c <script>`: macOS background-task management names the login item after the executable, and the inline form surfaced as a bare "sh" from an "Unknown Developer" in System Settings on every CLI-registered install.
  // The launcher carries the same N-1 capability probe; see `buildHostStartLauncherScript`.
  const programArgs = [
    serviceLauncherScriptPath(options.label),
    options.cli.command,
    ...options.cli.args,
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
  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${DESKTOP_APP_BUNDLE_ID}</string>
  </array>
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
  <string>Interactive</string>
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

/** Read the CLI invocation from the registered LaunchAgent plist, not from the invocation record. */
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
  if (args.length >= 2 && args[0] === serviceLauncherScriptPath(label)) {
    const command = args[1];
    if (command === undefined || !(await fileExists(command))) return null;
    return { command, args: args.slice(2) };
  }
  if (
    args.length >= 4 &&
    args[0] === "/bin/sh" &&
    args[1] === "-c" &&
    args[2]?.startsWith(COMPATIBLE_HOST_START_SCRIPT_PREFIX)
  ) {
    const command = args[3];
    if (command === undefined || !(await fileExists(command))) return null;
    return { command, args: args.slice(4) };
  }
  if (args.length < 3) return null;
  if (args[args.length - 2] !== "host" || args[args.length - 1] !== "start") {
    return null;
  }
  const command = args[0];
  if (command === undefined || !(await fileExists(command))) return null;
  return { command, args: args.slice(1, args.length - 2) };
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
  classifyLaunchdPrintOutput,
  isSmAppServiceLaunchAgentPath,
  readRegisteredCliInvocation,
};
