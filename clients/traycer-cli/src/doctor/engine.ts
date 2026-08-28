import { execFileSync } from "node:child_process";
import {
  access,
  lstat,
  readdir,
  readFile,
  readlink,
  stat,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname } from "node:path";
import { connect, type Socket } from "node:net";
import {
  cliCredentialsPath,
  cliPostFinalizeMarkerPath,
  hostCredentialPath,
  hostDevIdentityPoolRoot,
  hostIdentityNeedsReauthPath,
  hostNeedsReauthPath,
} from "../store/paths";
import {
  pendingUpgradeFinalisable,
  readPendingCliUpgrade,
} from "../commands/cli-upgrade";
import {
  markerDescribesUpgrade,
  readPostFinalizeMarker,
  type PostFinalizeMarkerRead,
} from "../upgrade/finalize-helper";
import {
  readBootstrapMarkers,
  type BootstrapLogEntry,
} from "../host/bootstrap-log";
import { isFatalSignal } from "../host/crash-diagnostics";
import {
  readHostPidMetadata,
  type HostLayer0Record,
  type HostPidMetadata,
} from "../host/pid-metadata";
import { callHostRpcAtEndpoint } from "../internal/host-rpc";
import { resolveHostAuth } from "../internal/host-auth";
import { HostRpcError } from "../../../shared/host-transport/host-messenger";
import type { HostTransportEndpoint } from "../../../shared/host-transport/ws-rpc-client";
import {
  readHostInstallRecord,
  type HostInstallRecord,
} from "../manifest/host-install";
import {
  readCliManifest,
  type CliInstallSource,
} from "../manifest/cli-manifest";
import {
  effectiveUpgradeGuidance,
  clientCompatibilityRecoveryHintForVector,
  resolveCompatRecovery,
  type CompatRecoveryPlan,
} from "../host/compat-recovery";
import { readCliFeedCompatibilityEpoch } from "../registry/cli-versions";
import type { IncompatibilityUpgradeGuidance } from "@traycer/protocol/framework/index";
import type { Environment } from "../runner/environment";
import { CliError } from "../runner/errors";
import {
  createServiceController,
  serviceLabelFor,
  type ServiceStatus,
} from "../service";
import { smAppServiceAgentLabelId } from "../service/label";
import {
  createRealLaunchdPrintRunner,
  probeMacosWedgedJob,
} from "./launchd-wedge";
import {
  createRealSystemdProbeRunner,
  probeLinuxSystemdHealth,
} from "./systemd-health";
import { isProcessAlive } from "../store/cli-lock";
import {
  DOCTOR_ISSUE_CODES,
  type DoctorIssue,
  type DoctorResult,
} from "./issues";
import {
  createRealRunCommand,
  resolvePortConflict,
  type ResolvePortConflictDeps,
} from "./port-conflict";

// Doctor engine - collects structured DoctorIssue records covering
// installed host presence, install-record integrity, service
// registration, pid metadata freshness, port reachability, recent
// crash/bootstrap markers, and the registry implementation gap.
//
// Design constraints from the Tech Plan:
//   - Issue codes are stable; severities map to the failure-card UI.
//   - Each issue carries a `fixAction` that Desktop maps back to a CLI
//     subcommand - Desktop never invents repairs.
//   - The same record set drives human-readable terminal output
//     (`renderHumanDoctorReport`) and the NDJSON `result.data` payload.

export interface RunDoctorOptions {
  readonly environment: Environment;
  // Dependency injection so tests can stub the conflicting-PID lookup
  // without spawning `lsof` / `ss` / `netstat`. Production callers
  // pass `null` and the engine falls back to the real shell-out
  // runner from `port-conflict.ts`. Required (no optional `?:`) per
  // project style.
  readonly portConflictDeps: ResolvePortConflictDeps | null;
}

export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorResult> {
  const issues: DoctorIssue[] = [];

  // ---- 1. Install record + executable integrity ----
  let record: HostInstallRecord | null;
  try {
    record = await readHostInstallRecord(opts.environment);
  } catch (err) {
    if (err instanceof CliError) {
      issues.push({
        code: DOCTOR_ISSUE_CODES.HOST_INSTALL_RECORD_INVALID,
        severity: "error",
        title: "Host install record is invalid",
        message: err.message,
        fixAction: "host-install-latest",
        terminalCommand: `traycer host install`,
        details: err.details,
      });
      record = null;
    } else {
      throw err;
    }
  }
  if (record === null) {
    issues.push({
      code: DOCTOR_ISSUE_CODES.HOST_NOT_INSTALLED,
      severity: "error",
      title: "Host not installed",
      message: `No host is installed for environment=${opts.environment}.`,
      fixAction: "host-install-latest",
      terminalCommand: `traycer host install`,
      details: { environment: opts.environment },
    });
  } else if (
    !(await access(record.executablePath).then(
      () => true,
      () => false,
    ))
  ) {
    issues.push({
      code: DOCTOR_ISSUE_CODES.HOST_BINARY_MISSING,
      severity: "error",
      title: "Installed host binary missing",
      message: `Install record points at an executable that does not exist on disk: ${record.executablePath}`,
      fixAction: "host-install-latest",
      terminalCommand: `traycer host install`,
      details: {
        executablePath: record.executablePath,
        version: record.version,
        source: record.source,
      },
    });
  } else if (record.signatureKeyId === "local-file:unsigned") {
    issues.push({
      code: DOCTOR_ISSUE_CODES.HOST_BINARY_UNVERIFIED,
      severity: "info",
      title: "Host installed from a local file (unsigned)",
      message: `The installed host (${record.version}) was staged from a local file and has no minisign signature.`,
      fixAction: null,
      terminalCommand: null,
      details: { source: record.source, archiveSha256: record.archiveSha256 },
    });
  }

  // ---- 2. Service registration ----
  const label = serviceLabelFor(opts.environment);
  let serviceStatus: ServiceStatus | null = null;
  let stoppedServiceIssue: DoctorIssue | null = null;
  try {
    serviceStatus = await createServiceController().status(label);
  } catch (err) {
    issues.push({
      code: DOCTOR_ISSUE_CODES.SERVICE_NOT_REGISTERED,
      severity: "error",
      title: "Service status check failed",
      message: err instanceof Error ? err.message : String(err),
      fixAction: "service-install",
      terminalCommand: `traycer host service install`,
      details: { label: label.id },
    });
  }
  if (serviceStatus !== null) {
    if (serviceStatus.state === "not-installed") {
      issues.push({
        code: DOCTOR_ISSUE_CODES.SERVICE_NOT_REGISTERED,
        severity: "error",
        title: "Service not registered",
        message: `The OS service '${label.id}' is not registered for this user.`,
        fixAction: "service-install",
        terminalCommand: `traycer host service install`,
        details: { label: label.id },
      });
    } else if (serviceStatus.state === "externally-managed") {
      // Desktop's SMAppService owns this label. This is a healthy
      // configuration, NOT a missing registration - and the old error card's
      // suggested fix (`service install`) refuses SMAppService-owned labels
      // by design, so surfacing it as an error routed users into a repair
      // loop with no working fix. Informational only.
      issues.push({
        code: DOCTOR_ISSUE_CODES.SERVICE_EXTERNALLY_MANAGED,
        severity: "info",
        title: "Service managed by Traycer Desktop",
        message: `The OS service for '${label.id}' is registered by the Traycer Desktop app (SMAppService login item); the CLI manages the host's lifecycle cooperatively but not its registration. Use the Traycer app to repair or remove the host on this machine. If the app itself is the broken part, take registration over from the CLI with 'traycer host service install --takeover'.`,
        // No `fixAction`: taking over Desktop's registration is an ownership
        // change and must stay an explicit user act, not a button on an
        // informational card - which is exactly what `--takeover` encodes.
        // The command is still handed over, because a card that NAMES an
        // escape hatch and gives you no way to copy it is the same dead end
        // as one that names nothing.
        fixAction: null,
        terminalCommand: `traycer host service install --takeover`,
        details: { label: label.id },
      });
    } else if (serviceStatus.state === "stopped") {
      // `host-start` is intentionally kept as the GUI `fixAction`
      // label - Desktop's CLI bridge maps that key to
      // `restartHost()` (see
      // desktop/src/electron-main/host/host-lifecycle.ts), which is
      // the idempotent, non-blocking service-recovery path.
      //
      // The `terminalCommand` (what the user copies from the Doctor
      // card) MUST NOT be `traycer host start`, though: that
      // subcommand is the long-running OS supervisor entrypoint
      // launchd/systemd/Scheduled Task manifests invoke - running it
      // from a shell would block the user's terminal until they hit
      // Ctrl-C, and risks two supervisors racing for the same socket.
      // Route the copyable command to `host restart`, which goes
      // through the service controller and returns immediately
      // regardless of prior service state.
      stoppedServiceIssue = {
        code: DOCTOR_ISSUE_CODES.SERVICE_STOPPED,
        severity: "warning",
        title: "Service registered but host stopped",
        message: `The OS service '${label.id}' is registered but the host process is not running.`,
        fixAction: "host-start",
        terminalCommand: `traycer host restart`,
        details: { label: label.id },
      };
    }
  }

  // ---- 3. Pid metadata freshness ----
  // These diagnostics used to drop their fixAction AND terminalCommand when
  // Desktop owned the label, on the premise that "the CLI must not hand the
  // user a fix for a job it doesn't control". That premise no longer holds:
  // `host restart` on a Desktop-managed machine asks the running host to
  // stand down over its own lifecycle RPCs and then kickstarts the agent
  // label - it controls the host's LIFECYCLE while mutating none of
  // Desktop's REGISTRATION. Ownership routes which mechanism runs; it is not
  // a reason to withhold the repair.
  //
  // Suppressing them turned every terminal card on a Desktop-managed
  // machine ("stale pid", "endpoint unreachable", "port held", "RPC failed")
  // into a description of a broken host with nothing to press and nothing to
  // copy - the dead end this whole change exists to remove. The card now
  // carries the repair that actually works there.
  const isExternallyManaged = serviceStatus?.state === "externally-managed";
  const pidMetadata = await readHostPidMetadata(opts.environment);
  const hostProcessAlive =
    pidMetadata !== null && isProcessAlive(pidMetadata.pid);
  if (!hostProcessAlive && stoppedServiceIssue !== null) {
    issues.push(stoppedServiceIssue);
  }
  if (pidMetadata === null) {
    if (serviceStatus?.state === "running") {
      issues.push({
        code: DOCTOR_ISSUE_CODES.PID_METADATA_MISSING,
        severity: "error",
        title: "Host pid metadata missing",
        message:
          "Service reports running but no pid metadata has been published - host may still be initialising or failed to write its endpoint.",
        fixAction: "host-restart",
        terminalCommand: `traycer host restart`,
        details: null,
      });
    }
  } else if (!hostProcessAlive) {
    issues.push({
      code: DOCTOR_ISSUE_CODES.PID_METADATA_STALE,
      severity: "warning",
      title: "Stale host pid metadata",
      message: `pid.json references pid=${pidMetadata.pid} which is no longer alive.`,
      fixAction: "host-restart",
      terminalCommand: `traycer host restart`,
      details: { pid: pidMetadata.pid, version: pidMetadata.version },
    });
  } else {
    // Independent of reachability: a degraded host is usually perfectly
    // reachable, which is exactly why this would otherwise never be noticed.
    const layer0Issue = layer0GuaranteeIssue(pidMetadata);
    if (layer0Issue !== null) {
      issues.push(layer0Issue);
    }
    const reachable = await probeWebsocketUrl(pidMetadata.websocketUrl);
    if (!reachable) {
      // Both calls are independent network/subprocess I/O - run in parallel.
      const portInfo = parseWebsocketPort(pidMetadata.websocketUrl);
      const conflictDeps: ResolvePortConflictDeps =
        opts.portConflictDeps !== null
          ? opts.portConflictDeps
          : {
              runCommand: createRealRunCommand(),
              platform: process.platform,
            };
      const conflict =
        portInfo !== null
          ? await resolvePortConflict(
              portInfo.port,
              new Set([pidMetadata.pid]),
              conflictDeps,
            )
          : null;
      if (conflict !== null && portInfo !== null) {
        // True port conflict: a *different* process is listening on the
        // host's port. Surface PID/name so the GUI's Free Port +
        // Restart card can ask for confirmation by identity (Flow 4).
        issues.push({
          code: DOCTOR_ISSUE_CODES.PORT_CONFLICT,
          severity: "error",
          title: "Host port held by another process",
          message: `Port ${portInfo.port} (${pidMetadata.websocketUrl}) is held by ${conflict.processName} (pid=${conflict.pid}), not the host (pid=${pidMetadata.pid}).`,
          // Safe under Desktop management too: freeing the port kills the
          // FOREIGN holder, and the restart that follows goes through the
          // same cooperative controller path.
          fixAction: "host-free-port-and-restart",
          terminalCommand: `traycer host free-port-and-restart --pid ${conflict.pid} --port ${portInfo.port}`,
          details: {
            pid: pidMetadata.pid,
            websocketUrl: pidMetadata.websocketUrl,
            port: portInfo.port,
            conflictingPid: conflict.pid,
            conflictingProcess: conflict.processName,
          },
        });
      } else {
        // Endpoint unreachable but we couldn't identify a foreign
        // holder. Route to restart/logs instead of Free Port + Restart -
        // killing an unknown PID (or port=0) is the unsafe path the
        // ticket explicitly forbids.
        issues.push({
          code: DOCTOR_ISSUE_CODES.PORT_UNREACHABLE,
          severity: "error",
          title: "Host endpoint unreachable",
          message: `Host process (pid=${pidMetadata.pid}) is running but its endpoint ${pidMetadata.websocketUrl} did not accept a TCP connection. No identifiable foreign listener on this port - restart the service.`,
          fixAction: "host-restart",
          terminalCommand: `traycer host restart`,
          details: {
            pid: pidMetadata.pid,
            websocketUrl: pidMetadata.websocketUrl,
            port: portInfo?.port ?? null,
            conflictingPid: null,
            conflictingProcess: null,
          },
        });
      }
    } else {
      // A bare TCP connect proves only that the port is open - not that a
      // client can actually talk to the host (the renderer still has to
      // complete the WS upgrade, present its bearer, and pass the protocol
      // handshake). Probe that authenticated path so doctor reflects what
      // the app experiences instead of staying green on a TCP accept. Pass the
      // already-resolved endpoint so the RPC probe hits the exact same host
      // URL the TCP probe just checked (no re-resolve that could race a
      // restart).
      const rpcIssue = await probeHostRpc(
        {
          hostId: pidMetadata.hostId,
          websocketUrl: pidMetadata.websocketUrl,
        },
        opts.environment,
      );
      if (rpcIssue !== null) {
        issues.push(rpcIssue);
      }
    }
  }

  // ---- 4. Pending CLI upgrade ----
  // READ the marker the detached finalize helper may have written on a prior
  // restart cycle; do not consume it.
  //
  // This used to call `reconcilePostFinalizeMarker`, which deletes the marker
  // file and can rewrite the CLI install manifest to clear `pendingUpgrade`.
  // The intent was benign - make doctor's report reflect the helper's outcome
  // without waiting for another `host restart` - but it made a diagnostic
  // command mutate CLI upgrade state as a side effect of being asked a
  // question (audit finding CLI-007). Running `host doctor` twice gave two
  // different answers, and anyone inspecting a broken machine destroyed the
  // evidence by looking at it.
  //
  // Reporting the marker instead gets the same honesty with none of the
  // mutation: doctor can still say "the swap already happened, only the
  // bookkeeping is stale", and the fix it names - `traycer host restart` - is
  // the lifecycle command that actually performs the reconcile
  // (commands/host-restart.ts). Observation here, mutation there.
  const finalizeMarker = await readPostFinalizeMarker({
    environment: opts.environment,
  });
  // Read here rather than at section 6 because the finalize marker's
  // service-start report needs this history: "is the host up right now" cannot
  // distinguish a start failure the host never recovered from, from one it
  // recovered from before a later, unrelated stop.
  const bootstrapMarkers = await readBootstrapMarkers(opts.environment, 20);
  // An UNREADABLE marker is a fault in its own right, and independent of
  // whether the manifest currently has a pending upgrade. `readPostFinalize-
  // Marker` distinguishes `invalid` from `absent` precisely so it can be
  // reported; consulting that only inside the pending-upgrade branch below
  // would mean a corrupt marker on a manifest with nothing pending produces
  // silence, and doctor calls the CLI-upgrade state clean while a file it
  // could not parse sits on disk shaping the next `host restart`.
  if (finalizeMarker.status === "invalid") {
    // Whether `host restart` can actually clear this depends on a fact the
    // marker's CONTENTS cannot tell us: reconciliation removes an unparseable
    // marker with `safeUnlink`, which swallows its errors, so on a directory
    // this user cannot write to the restart completes and the marker - and
    // this warning - survive untouched, forever.
    //
    // `W_OK` on the parent is NECESSARY but not SUFFICIENT, and the copy below
    // is written to match exactly that. A readable marker owned by another
    // user inside a writable STICKY directory passes this check and still
    // fails to unlink with EPERM, and Windows ACL delete rights can diverge
    // from writability in their own ways. Establishing deletability for real
    // would mean ownership plus sticky-bit inspection on POSIX and an ACL
    // query on Windows - and a wrong prediction in EITHER direction is worse
    // than not predicting: refusing to name the repair that would have worked,
    // or promising one that cannot.
    //
    // So the negative result is still asserted (a non-writable directory
    // definitely cannot be unlinked from, which is worth saying outright), and
    // the positive one is described rather than guaranteed: try the restart,
    // and here is what it means if the warning survives it.
    const markerDirWritable = await access(
      dirname(cliPostFinalizeMarkerPath(opts.environment)),
      fsConstants.W_OK,
    ).then(
      () => true,
      () => false,
    );
    issues.push({
      code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_MARKER_UNPARSEABLE,
      severity: "warning",
      title: "CLI upgrade finalize marker is not readable as a marker",
      message:
        `The finalize helper's marker at ${cliPostFinalizeMarkerPath(opts.environment)} could not be parsed: ` +
        `${finalizeMarker.errorMessage}. Doctor cannot tell whether a staged CLI swap completed. ` +
        (markerDirWritable
          ? "Run 'traycer host restart': its reconcile step attempts to discard a marker it cannot parse. " +
            "If this warning is still here afterwards, the file's own ownership or permissions are preventing deletion " +
            "(a marker left by another user, for example) - remove it by hand. " +
            "If a CLI upgrade still appears stuck after that, re-run 'traycer cli upgrade' to re-stage it."
          : "Its directory is not writable by this user, so 'traycer host restart' cannot delete it either - " +
            "its reconcile step would complete while leaving this warning in place. " +
            "Fix the ownership or permissions on that directory first."),
      // `host restart` is the command that actually clears this. The previous
      // `traycer cli upgrade` was inert against the reported condition - it
      // never touches post-finalize.json, so an already-current CLI would
      // leave the same marker in place and every later doctor run would
      // repeat the identical warning. Offering a command that cannot resolve
      // what it is offered for is the CLI-006 defect wearing different
      // clothes: the string parses, it just does not do the job.
      //
      // Scoped to the PARSE-failure subtype for precisely that reason - see
      // the `unreadable` branch below, where the same promise would be false -
      // and withheld again when the directory is not writable, where the
      // deletion that makes it true cannot happen.
      fixAction: markerDirWritable ? "host-restart" : null,
      terminalCommand: markerDirWritable ? `traycer host restart` : null,
      details: {
        markerPath: cliPostFinalizeMarkerPath(opts.environment),
        errorMessage: finalizeMarker.errorMessage,
        markerDirWritable,
      },
    });
  }
  // The marker file exists and cannot be READ. Deliberately no fix action and
  // no terminal command: `reconcilePostFinalizeMarker` reads the file the same
  // way this probe just failed to, and returns without unlinking when that
  // read throws - so `host restart` would leave the marker, the warning, and
  // the user's impression that they had been given a repair exactly as they
  // were. Nothing on a command line fixes a permission; the message has to
  // carry the actual remedy, which is what it does.
  if (finalizeMarker.status === "unreadable") {
    issues.push({
      code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_MARKER_UNREADABLE,
      severity: "warning",
      title: "Cannot read the CLI upgrade finalize marker",
      message:
        `The finalize helper's marker at ${cliPostFinalizeMarkerPath(opts.environment)} exists but could not be read: ` +
        `${finalizeMarker.errorMessage}. Doctor cannot tell whether a staged CLI swap completed, and neither can ` +
        "'traycer host restart' - its reconcile step reads the same file and will leave it in place. " +
        "Check the ownership and permissions on that file and its directory; they should belong to the user Traycer runs as.",
      fixAction: null,
      terminalCommand: null,
      details: {
        markerPath: cliPostFinalizeMarkerPath(opts.environment),
        errorMessage: finalizeMarker.errorMessage,
      },
    });
  }

  // `traycer cli upgrade` stages a new binary and records
  // `pendingUpgrade` when the live binary is locked (Windows: the
  // supervisor holds the .exe; cross-platform: read-only filesystem).
  // Doctor surfaces the staged upgrade so the user knows a swap is
  // queued, and offers `host restart` as the fix - restarting the
  // service releases the binary lock and the next CLI invocation (or
  // the finalize hook on `host restart`) completes the swap.
  const pendingUpgrade = await readPendingCliUpgrade({
    environment: opts.environment,
  });
  // A SWAPPED MARKER CARRYING A SERVICE-START FAILURE, on a manifest with
  // nothing pending. This is not an exotic combination - it is the NORMAL
  // on-disk state for that failure, which is why gating marker interpretation
  // on `pendingUpgrade !== null` lost it entirely.
  //
  // The ordering in `commands/cli-finalize-upgrade.ts` is: run the swap
  // (`finalizePendingCliUpgrade`, which CLEARS `pendingUpgrade` on success),
  // then try to start the service, then write the marker recording whether
  // that start failed. So by the time a `serviceStartError` exists to report,
  // the pending record it would have been attached to is already gone.
  //
  // Other probes will notice the host is not running, but none of them can
  // say WHY - and the helper's own error is the only artifact that explains
  // it.
  //
  // The gate is DUPLICATION, not pending state. An earlier version skipped
  // this whenever any pending upgrade existed, which lost the error in a
  // second, entirely reachable arrangement: an old `swapped` marker carrying
  // a `serviceStartError` survives, a later `cli upgrade` records a NEW
  // pending upgrade, and `postFinalizeMarkerIssue` then correctly rejects
  // that marker as stale - so nothing reported the failure at all, while the
  // host stayed down for exactly the reason the marker names.
  //
  // The only case that must not double-report is a marker the pending card
  // already covers, since that card appends the same `serviceStartError` to
  // its own message. That is precisely `markerDescribesUpgrade`, so it is
  // asked here rather than approximated by "is anything pending".
  const matchingPendingMarker =
    pendingUpgrade !== null &&
    finalizeMarker.status === "present" &&
    markerDescribesUpgrade(finalizeMarker.marker, {
      stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
      livePath: pendingUpgrade.binaryPath,
      stagedAt: pendingUpgrade.pending.stagedAt,
    })
      ? finalizeMarker.marker
      : null;
  const markerCoveredByPendingCard = matchingPendingMarker !== null;
  const pendingMarkerServiceStartError =
    matchingPendingMarker?.serviceStartError ?? null;
  if (
    !markerCoveredByPendingCard &&
    finalizeMarker.status === "present" &&
    (finalizeMarker.marker.status === "swapped" ||
      finalizeMarker.marker.status === "swap-failed") &&
    finalizeMarker.marker.serviceStartError !== null
  ) {
    const markerSwapCompleted = finalizeMarker.marker.status === "swapped";
    // Empty paths are the explicit identity-less marker written when the
    // detached helper discovers that no pending manifest remains. Every
    // attempted swap carries both paths, even if its manifest is later
    // cleared or replaced, so preserve that failed-swap history instead of
    // describing all uncovered markers as empty finalization.
    const markerAttemptedSwap =
      finalizeMarker.marker.livePath !== "" ||
      finalizeMarker.marker.stagedBinaryPath !== "";
    const markerOutcomeMessage = markerSwapCompleted
      ? "The upgrade itself succeeded - the new CLI is live - so this is not an upgrade to retry. "
      : markerAttemptedSwap
        ? `The CLI swap from ${finalizeMarker.marker.stagedBinaryPath} to ${finalizeMarker.marker.livePath} failed: ` +
          `${finalizeMarker.marker.errorMessage ?? "no error message recorded"}. `
        : "No pending CLI upgrade remained for the helper to apply. ";
    // THE MARKER IS HISTORY, NOT A LIVE READING. It records what happened at
    // `attemptedAt` and then persists until some later `host restart`
    // reconciles it - so on a machine whose supervisor already recovered the
    // host, an unconditional warning would assert "the host is down" while
    // this same doctor run has positive evidence that it is up. That is the
    // failure mode this PR exists to remove, and reporting it about a stale
    // file rather than a command's return value does not make it better.
    //
    // Both states are worth saying, so the severity carries the difference
    // instead of suppressing one: a host that is still down gets an
    // actionable warning, and a host that recovered gets an info-level note
    // explaining the outage it just had. Info keeps `host doctor`'s exit code
    // (error/fatal only) unaffected for a machine that is now healthy.
    //
    // TWO SEPARATE FACTS, deliberately not merged into one boolean.
    //
    // An earlier revision folded "a `starting` marker exists after
    // `attemptedAt`" into the liveness flag, and got both halves wrong at
    // once. `starting` is written by `host-start.ts` BEFORE it opens the log
    // fd and spawns the child, so the same attempt can go on to emit
    // `failed-to-spawn` or `crashed` - it is evidence that another attempt
    // BEGAN, never that one succeeded. Treating it as recovery downgraded a
    // host that has never come up to informational and took away its fix. And
    // because the merged flag also drove the copy, the card said "The host is
    // running now" and reported `hostRunningNow: true` while the service probe
    // and pid probe both said it was down - contradicting the outage the rest
    // of the same report was describing.
    //
    // So liveness decides severity, because "the host is down" is the
    // actionable part and it is the one thing here that is directly observed.
    // History only qualifies the wording: if a start has been attempted since
    // this failure, the current outage may well have a different cause, and
    // saying so is useful without pretending to know that it does.
    const markerAt = Date.parse(finalizeMarker.marker.attemptedAt);
    const startAttemptedSince = bootstrapMarkers.some((entry) => {
      if (entry.phase !== "starting") return false;
      const entryAt = Date.parse(entry.timestamp);
      return (
        Number.isFinite(entryAt) &&
        Number.isFinite(markerAt) &&
        entryAt > markerAt
      );
    });
    const hostRunningNow =
      hostProcessAlive || serviceStatus?.state === "running";
    issues.push({
      code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_SERVICE_START_FAILED,
      severity: hostRunningNow ? "info" : "warning",
      title: hostRunningNow
        ? "Host briefly failed to start after CLI finalization (since recovered)"
        : markerSwapCompleted
          ? "CLI upgrade completed but the host service did not start"
          : "CLI finalization ended without restarting the host service",
      message: hostRunningNow
        ? `The finalize helper ran at ${finalizeMarker.marker.attemptedAt} and could not start the host service: ` +
          `${finalizeMarker.marker.serviceStartError}. ${markerOutcomeMessage}` +
          "The host is running now, so this is a record of a past outage rather than a live fault - " +
          "quote it if you are investigating why the host was briefly unavailable around that time. The next 'traycer host restart' clears the record."
        : `The finalize helper ran at ${finalizeMarker.marker.attemptedAt} and then failed to start the host service: ` +
          `${finalizeMarker.marker.serviceStartError}. ` +
          markerOutcomeMessage +
          (startAttemptedSince
            ? "The host has been started at least once since then, so the outage you are looking at now may have a different cause - check the recent activity below. "
            : "") +
          "Either way the host is down; start it with 'traycer host restart'.",
      fixAction: hostRunningNow ? null : "host-restart",
      terminalCommand: hostRunningNow ? null : `traycer host restart`,
      details: {
        markerPath: cliPostFinalizeMarkerPath(opts.environment),
        attemptedAt: finalizeMarker.marker.attemptedAt,
        serviceStartError: finalizeMarker.marker.serviceStartError,
        livePath: finalizeMarker.marker.livePath,
        stagedBinaryPath: finalizeMarker.marker.stagedBinaryPath,
        errorMessage: finalizeMarker.marker.errorMessage,
        // Directly observed, and named for exactly what it is. Kept apart from
        // the history flag below so nothing downstream can read one as the
        // other, which is how the contradiction above happened.
        hostRunningNow,
        startAttemptedSinceFailure: startAttemptedSince,
      },
    });
  }
  if (pendingUpgrade !== null) {
    // A marker that already settled the swap outranks everything below it:
    // the manifest still says "pending", but the disk says otherwise, and
    // reporting the manifest alone would send the reader to re-stage an
    // upgrade that has already happened.
    const stagedExists = await pendingUpgradeFinalisable({
      stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
    });
    const settled = postFinalizeMarkerIssue(
      finalizeMarker,
      {
        version: pendingUpgrade.pending.version,
        stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
        currentVersion: pendingUpgrade.currentVersion,
        binaryPath: pendingUpgrade.binaryPath,
        stagedAt: pendingUpgrade.pending.stagedAt,
      },
      stagedExists,
    );
    if (settled !== null) {
      issues.push(settled);
    } else if (!stagedExists) {
      // The staged binary has been deleted out from under the manifest
      // (cleanup, AV, ...). There is no machine-driven recovery -
      // surface the terminal command so the user can re-run upgrade
      // explicitly, but don't offer a Doctor auto-fix button (the
      // Desktop bridge doesn't proxy `cli upgrade` through the host
      // management IPC surface).
      issues.push({
        code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_PENDING,
        severity: "warning",
        title: "CLI upgrade staged but staged binary is missing",
        message:
          `cli upgrade has pendingUpgrade=${pendingUpgrade.pending.version} but ` +
          `the staged binary at ${pendingUpgrade.pending.stagedBinaryPath} ` +
          "is no longer on disk. Re-run 'traycer cli upgrade' to re-stage." +
          (pendingMarkerServiceStartError === null
            ? ""
            : ` The finalize helper also could not restart the host service: ${pendingMarkerServiceStartError}`),
        fixAction: null,
        terminalCommand: `traycer cli upgrade`,
        details: {
          stagedVersion: pendingUpgrade.pending.version,
          stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
          stagedAt: pendingUpgrade.pending.stagedAt,
          reason: pendingUpgrade.pending.reason,
          currentVersion: pendingUpgrade.currentVersion,
          binaryPath: pendingUpgrade.binaryPath,
          finalizeMarker: finalizeMarkerDetail(finalizeMarker),
          serviceStartError: pendingMarkerServiceStartError,
        },
      });
    } else {
      issues.push({
        code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_PENDING,
        severity: "warning",
        title: `CLI upgrade pending (${pendingUpgrade.pending.version})`,
        message:
          `cli upgrade staged ${pendingUpgrade.pending.version} at ` +
          `${pendingUpgrade.pending.stagedBinaryPath}; ` +
          `live binary at ${pendingUpgrade.binaryPath} is locked ` +
          `(reason=${pendingUpgrade.pending.reason}). ` +
          "Restart the host service to finalise the swap.",
        fixAction: "host-restart",
        terminalCommand: `traycer host restart`,
        details: {
          stagedVersion: pendingUpgrade.pending.version,
          stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
          stagedAt: pendingUpgrade.pending.stagedAt,
          reason: pendingUpgrade.pending.reason,
          currentVersion: pendingUpgrade.currentVersion,
          binaryPath: pendingUpgrade.binaryPath,
          source: pendingUpgrade.source,
          finalizeMarker: finalizeMarkerDetail(finalizeMarker),
        },
      });
    }
  }

  // ---- 4a. macOS launchd job wedge ----
  // Registration presence is not health: launchd can hold the label loaded
  // while the job is unable to run, and every ownership-keyed check reads
  // that as "healthy". Read the job's run state directly.
  if (process.platform === "darwin") {
    const wedgeIssue = await probeMacosWedgedJob({
      labelId: label.id,
      agentLabelId: smAppServiceAgentLabelId(label),
      hasPidMetadata: pidMetadata !== null,
      runner: createRealLaunchdPrintRunner(),
    });
    if (wedgeIssue !== null) issues.push(wedgeIssue);
  }

  // ---- 4a-linux. systemd user-manager health ----
  // The Linux counterpart of the launchd wedge probe. Reads the manager's
  // actual run state: no reachable user bus (WSL without systemd, sudo su),
  // a failed / restart-looping unit ("stopped" everywhere else, since
  // liveness deliberately keys off pid metadata), a start skipped because
  // the CLI binary is gone, and disabled lingering.
  if (process.platform === "linux") {
    const systemdIssues = await probeLinuxSystemdHealth({
      labelId: label.id,
      unitFileInstalled:
        serviceStatus !== null && serviceStatus.state !== "not-installed",
      runner: createRealSystemdProbeRunner(),
    });
    issues.push(...systemdIssues);
  }

  // ---- 4b. CLI slot binary health ----
  // The manifest's binaryPath may be a symlink into the Desktop app
  // bundle; a bundle remove/replace leaves it dangling, and the only
  // repair is the app's own cli-reconcile at its next successful launch.
  const cliSlotIssue = await probeDanglingCliSlotBinary(opts.environment);
  if (cliSlotIssue !== null) issues.push(cliSlotIssue);

  // ---- 4c. Host delegated-credential health ----
  // Local, cheap, and the only surface that reports this at all: the host
  // reports `needs-reauth` to CLIENTS on every stream open, but a user whose
  // client cannot get far enough to see that has nothing else to look at.
  const credentialIssue = await probeHostCredentialNeedsReauth(
    opts.environment,
  );
  if (credentialIssue !== null) issues.push(credentialIssue);

  // ---- 4d. Host identity-plane health ----
  // The OTHER needs-reauth marker. Same filename, different directory,
  // different plane, and a recovery that is the opposite of 4c's - so it gets
  // its own probe and its own codes rather than a branch inside that one.
  //
  // Unlike 4c this probe can never say "clean", because the location it reads
  // is only the DEFAULT identity home and the host may have acquired another.
  // `hostProcessAlive` is passed so the deferral names something the reader
  // can act on: a running host answers this authoritatively.
  const identityIssue = await probeHostIdentityNeedsReauth(
    opts.environment,
    hostProcessAlive,
  );
  if (identityIssue !== null) issues.push(identityIssue);

  // ---- 5. Windows credentials ACL ----
  // Windows ignores POSIX mode bits on the credentials file. On a
  // shared / VDI host, other users may have read access via default
  // Windows ACL inheritance. Probe `icacls` and warn if any
  // non-owner principal has read permission.
  if (process.platform === "win32") {
    const aclIssue = await probeWindowsCredentialsAcl(opts.environment);
    if (aclIssue !== null) issues.push(aclIssue);
  }

  // ---- 5b. Windows Script Host policy ----
  // The scheduled task launches the host through wscript.exe. With the WSH
  // Enabled=0 policy set (common enterprise hardening), the launcher never
  // executes and nothing surfaces - probed live: `//B` suppresses even the
  // block dialog, so the host silently never starts at login. Install-time
  // verification can't see a policy applied later; this can.
  if (
    process.platform === "win32" &&
    serviceStatus !== null &&
    serviceStatus.state !== "not-installed"
  ) {
    const wshIssue = probeWindowsScriptHostPolicy();
    if (wshIssue !== null) issues.push(wshIssue);
  }

  // ---- 6. Recent bootstrap markers ----
  // Already read above (the finalize marker's service-start report needs the
  // same history to tell a live failure from one the host recovered from).
  const recentMarkers = bootstrapMarkers;
  const recentCrash = lastCrashMarker(recentMarkers);
  if (recentCrash !== null) {
    const fields = recentCrash.entry.fields;
    const baseTitle =
      recentCrash.entry.phase === "failed-to-spawn"
        ? "Host failed to spawn recently"
        : "Host crashed recently";
    issues.push({
      code: DOCTOR_ISSUE_CODES.RECENT_CRASH_MARKERS,
      severity: recentCrash.recovered
        ? "warning"
        : hostProcessAlive || serviceStatus?.state === "running"
          ? "warning"
          : "error",
      title: recentCrash.recovered
        ? `${baseTitle} (recovered by restart)`
        : baseTitle,
      message: formatMarkerMessage(recentCrash.entry),
      fixAction: "host-logs",
      terminalCommand: `traycer host logs --tail 200`,
      details: {
        phase: recentCrash.entry.phase,
        timestamp: recentCrash.entry.timestamp,
        recovered: recentCrash.recovered,
        fields,
      },
    });
  }

  return { issues };
}

/**
 * Surfaces a running host that does NOT hold the Layer 0 single-writer
 * guarantee.
 *
 * This is the only place a support engineer can learn the fact without log
 * archaeology. The host records it in pid.json precisely because its other
 * channels do not survive: the framed status pipe has no reader on an ordinary
 * production start, and the `[host] layer0-degraded` stderr line is one line
 * at the very top of a log whose diagnostic tail is 200 lines and whose
 * support attachment is 500.
 *
 * `null` for an acquired host, and for a pid.json that predates the field -
 * absence is "not recorded", and inventing a warning for every host older than
 * this CLI would drown the real signal.
 */
/**
 * A Layer 0 record that does NOT carry the guarantee - degraded, or a shape
 * this CLI cannot read. Named rather than inlined so the two-home loop below
 * narrows once instead of at every use.
 */
type UnguaranteedLayer0Record = Exclude<
  HostLayer0Record,
  { readonly status: "acquired" }
>;

function layer0GuaranteeIssue(
  pidMetadata: HostPidMetadata,
): DoctorIssue | null {
  // `?? null` rather than a bare null check: a pid.json older than this field
  // decodes without the key at all, and so does any in-process fixture that
  // predates it. Both mean "not recorded".
  const record = pidMetadata.layer0 ?? null;
  // ...and the SLOT home's own verdict, on a dev pool host that took two locks
  // (chat-sync-v2 ticket 38). EITHER home failing costs the guarantee, so this
  // arm must fire on the slot record even when the identity record is a clean
  // `acquired` - that combination is precisely the half-truth the field was
  // added to end. `null` on every ordinary host and every older pid.json.
  const slotRecord = pidMetadata.layer0Slot ?? null;
  const degraded: { home: string; record: UnguaranteedLayer0Record }[] = [];
  for (const entry of [
    { home: "identity", record },
    { home: "slot", record: slotRecord },
  ]) {
    if (entry.record === null || entry.record.status === "acquired") continue;
    degraded.push({ home: entry.home, record: entry.record });
  }
  if (degraded.length === 0) {
    return null;
  }
  const detail = degraded
    .map(({ home, record: entry }) =>
      entry.status === "degraded"
        ? `${home} home: cause=${entry.cause} evidence=${entry.evidence}`
        : `${home} home: this CLI does not recognise the record it published (${entry.raw})`,
    )
    .join("; ");
  return {
    code: DOCTOR_ISSUE_CODES.HOST_LAYER0_NOT_GUARANTEED,
    severity: "warning",
    title: "Host is running without the single-writer guarantee",
    message:
      `Host pid=${pidMetadata.pid} started without Layer 0's single-writer ` +
      `lock on its data directory: ${detail}. The host is serving normally - ` +
      "this is a deliberate degradation, not a failure - but a second host " +
      "started against the same data directory would not be refused, so " +
      "quote this in any report of duplicated or corrupted host state.",
    // No CLI fix exists: the remedy depends on the cause (a reinstall for a
    // missing native addon, relocating the data directory off a network
    // filesystem for fs-unsupported). Offering `host restart` would just
    // reproduce the same degradation.
    fixAction: null,
    terminalCommand: null,
    details: {
      pid: pidMetadata.pid,
      hostId: pidMetadata.hostId,
      layer0: record,
      // Reported alongside rather than folded into `layer0`: an investigator
      // reading this needs to know WHICH home lost the lock, and a merged
      // value would answer a question nobody asked.
      layer0Slot: slotRecord,
    },
  };
}

/**
 * The manifest fields the post-finalize reporting needs. Named rather than
 * threading `readPendingCliUpgrade`'s whole anonymous return shape through,
 * so this stays a pure projection of four strings.
 */
interface PendingUpgradeFacts {
  readonly version: string;
  readonly stagedBinaryPath: string;
  readonly currentVersion: string;
  readonly binaryPath: string;
  readonly stagedAt: string;
}

/**
 * Turns a post-finalize marker into the issue that DESCRIBES it, for the two
 * marker states that contradict the manifest's `pendingUpgrade` record.
 *
 * `null` means "this marker does not override the manifest" - absent (the
 * helper never ran or is still running), invalid, or `parent-still-alive`
 * (the helper gave up waiting, so the upgrade really is still pending and the
 * ordinary pending card is the honest report). Those fall through to the
 * caller's existing branches, which carry the marker status in `details`.
 *
 * Doctor no longer consumes the marker (CLI-007), so both issues below name
 * `traycer host restart` - the lifecycle command that performs the reconcile
 * this report is describing the absence of.
 */
function postFinalizeMarkerIssue(
  read: PostFinalizeMarkerRead,
  pending: PendingUpgradeFacts,
  stagedExists: boolean,
): DoctorIssue | null {
  if (read.status !== "present") return null;
  const marker = read.marker;
  // CORRELATE THE MARKER WITH THIS PENDING UPGRADE BEFORE BELIEVING IT.
  //
  // The marker carries no version - only the two paths it operated on - so
  // "a marker exists" is not evidence about "the upgrade the manifest is
  // currently pending". The helper writes the marker and `host restart`
  // consumes it, but nothing guarantees that consumption happened: a helper
  // that swapped 1.2.0 can leave its marker behind, and a later
  // `traycer cli upgrade` will overwrite `pendingUpgrade` with 1.3.0 without
  // clearing it. Doctor would then read the 1.2.0 marker as proof that 1.3.0
  // is "already applied" and tell the user their upgrade was done - the
  // opposite of true, and unfalsifiable from the card.
  //
  // `stagedBinaryPath` is a strong discriminator because `cli upgrade` stamps
  // the target version into the filename it stages to
  // (`traycer-<version>-<platform>`), so a mismatch here is precisely the
  // stale-marker case. A mismatched marker is treated as not describing this
  // upgrade at all: the caller falls through to the ordinary pending report,
  // which carries the marker's status in `details` for anyone investigating.
  // Both paths, for the reason spelled out in `reconcilePostFinalizeMarker`:
  // the staged filename carries the version and defeats a stale-VERSION
  // marker, but `cli re-anchor` can repoint the live binary without deleting
  // the marker, so a same-version retry would match on staged path alone.
  // Identity is decided by the SHARED `markerDescribesUpgrade` predicate, not
  // re-implemented here. These two call sites disagreeing is not hypothetical:
  // it happened in this PR's history, and produced doctor announcing an
  // upgrade as already applied while `host restart` correctly discarded the
  // same marker as stale. One predicate, one answer.
  if (
    !markerDescribesUpgrade(marker, {
      stagedBinaryPath: pending.stagedBinaryPath,
      livePath: pending.binaryPath,
      stagedAt: pending.stagedAt,
    })
  ) {
    return null;
  }
  // A `swap-failed` marker whose staged bytes have since been deleted is NOT
  // the story to tell. `host restart` - the fix this branch offers - would
  // consume the marker, find nothing to finalize, and leave the upgrade
  // pending exactly as it was. The caller's `!stagedExists` branch has the
  // guidance that actually recovers it ("re-run 'traycer cli upgrade' to
  // re-stage"), so defer to it.
  //
  // Deliberately not applied to `swapped`: there, the staged binary is
  // MEANT to be gone, because the helper moved it onto the live path. Absence
  // is the expected end state of a success, so treating it as a fault would
  // report every completed swap as a missing-stage failure.
  if (marker.status === "swap-failed" && !stagedExists) return null;
  if (marker.status === "swapped") {
    // The bytes are already swapped; only the manifest is behind. INFO, not
    // warning: nothing is broken and nothing is at risk, so this must not
    // flip `host doctor`'s exit code (which keys off error/fatal) for a
    // machine that is, in every way that matters, already upgraded.
    return {
      code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_FINALIZED_UNRECONCILED,
      severity: "info",
      title: `CLI upgrade to ${pending.version} already applied`,
      message:
        `The finalize helper swapped ${pending.stagedBinaryPath} onto ` +
        `${pending.binaryPath} at ${marker.attemptedAt}, so the new CLI is ` +
        `already live. The install manifest still records the upgrade as ` +
        `pending (version=${pending.currentVersion}) because nothing has ` +
        "folded the helper's result in yet - 'traycer host doctor' only " +
        "reports state, it does not change it. The next 'traycer host " +
        "restart' reconciles the record; until then this is bookkeeping " +
        "drift, not a failure." +
        (marker.serviceStartError === null
          ? ""
          : ` Note the helper could not start the host service afterwards: ${marker.serviceStartError}`),
      fixAction: "host-restart",
      terminalCommand: `traycer host restart`,
      details: {
        stagedVersion: pending.version,
        stagedBinaryPath: pending.stagedBinaryPath,
        currentVersion: pending.currentVersion,
        binaryPath: pending.binaryPath,
        markerStatus: marker.status,
        attemptedAt: marker.attemptedAt,
        serviceStartError: marker.serviceStartError,
      },
    };
  }
  if (marker.status === "swap-failed") {
    // Distinct from the ordinary pending card, which says "the live binary is
    // locked, restart to finalise". That advice is wrong here: a helper
    // already ran with the lock released and the swap itself failed, so
    // repeating the restart is not obviously the cure and the operator needs
    // the helper's error to decide.
    return {
      code: DOCTOR_ISSUE_CODES.CLI_UPGRADE_FINALIZE_FAILED,
      severity: "warning",
      title: `CLI upgrade to ${pending.version} failed to finalize`,
      message:
        `The finalize helper ran at ${marker.attemptedAt} and could not swap ` +
        `${pending.stagedBinaryPath} onto ${pending.binaryPath}: ` +
        `${marker.errorMessage ?? "no error message recorded"}. ` +
        `The CLI is still ${pending.currentVersion} and the upgrade remains ` +
        "pending. 'traycer host restart' retries the whole flow; if it keeps " +
        "failing, the live binary's directory is likely not writable by this " +
        "user." +
        (marker.serviceStartError === null
          ? ""
          : ` The helper also could not restart the host service: ${marker.serviceStartError}`),
      fixAction: "host-restart",
      terminalCommand: `traycer host restart`,
      details: {
        stagedVersion: pending.version,
        stagedBinaryPath: pending.stagedBinaryPath,
        currentVersion: pending.currentVersion,
        binaryPath: pending.binaryPath,
        markerStatus: marker.status,
        attemptedAt: marker.attemptedAt,
        errorMessage: marker.errorMessage,
        serviceStartError: marker.serviceStartError,
      },
    };
  }
  return null;
}

/**
 * Compact, always-safe projection of the marker read for an issue's
 * `details`. Support bundles want to know which of the five states doctor
 * saw even when the marker did not change the verdict.
 */
function finalizeMarkerDetail(read: PostFinalizeMarkerRead): string {
  if (read.status === "absent") return "absent";
  if (read.status === "invalid") return `invalid: ${read.errorMessage}`;
  if (read.status === "unreadable") return `unreadable: ${read.errorMessage}`;
  return read.marker.status;
}

function lastCrashMarker(
  entries: readonly BootstrapLogEntry[],
): { readonly entry: BootstrapLogEntry; readonly recovered: boolean } | null {
  let recovered = false;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (
      entry.phase === "crashed" ||
      entry.phase === "failed-to-spawn" ||
      // A fatal signal (SIGABRT et al.) is a crash wearing the killed phase:
      // Node fatal aborts on POSIX surface as signal deaths, and skipping
      // them here would hide exactly the evidence the enrichment attaches.
      (entry.phase === "killed" && isFatalSignal(entry.fields.signal))
    ) {
      return { entry, recovered };
    }
    if (entry.phase === "starting") {
      // A more recent start used to CANCEL the crash signal entirely - which
      // erased the evidence in exactly the auto-respawn-recovered case where
      // the crash is the only thing worth diagnosing. It now only downgrades
      // the finding to "recovered".
      recovered = true;
    }
  }
  return null;
}

function formatMarkerMessage(entry: BootstrapLogEntry): string {
  const parts: string[] = [`phase=${entry.phase}`, `at=${entry.timestamp}`];
  if (entry.fields.code !== undefined) parts.push(`code=${entry.fields.code}`);
  if (entry.fields.exitMeaning !== undefined)
    parts.push(`meaning=${entry.fields.exitMeaning}`);
  if (entry.fields.signal !== undefined)
    parts.push(`signal=${entry.fields.signal}`);
  if (entry.fields.error !== undefined)
    parts.push(`error=${entry.fields.error}`);
  if (entry.fields.report !== undefined)
    parts.push(`report=${entry.fields.report}`);
  return parts.join(" ");
}

// Probe `icacls <credentialsPath>` and return a Doctor issue if any
// principal other than the file owner / well-known system principals
// has read access. Returns null when the file is owner-only or when
// the probe itself fails (icacls missing, transient error).
/**
 * Reads the Windows Script Host Enabled policy from both hives. `0` in
 * either disables wscript.exe for this user, which kills the host's
 * scheduled-task launch chain silently. HKCU wins over HKLM only in the
 * sense that EITHER being 0 blocks; a missing value means enabled.
 */
function probeWindowsScriptHostPolicy(): DoctorIssue | null {
  const disabledIn: string[] = [];
  for (const hive of ["HKLM", "HKCU"]) {
    let stdout: string;
    try {
      stdout = execFileSync(
        "reg",
        [
          "query",
          `${hive}\\Software\\Microsoft\\Windows Script Host\\Settings`,
          "/v",
          "Enabled",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5000 },
      );
    } catch {
      // Key or value absent - WSH enabled by default.
      continue;
    }
    if (/Enabled\s+REG_DWORD\s+0x0\b/i.test(stdout)) disabledIn.push(hive);
  }
  if (disabledIn.length === 0) return null;
  return {
    code: DOCTOR_ISSUE_CODES.WINDOWS_SCRIPT_HOST_DISABLED,
    severity: "error",
    title: "Windows Script Host is disabled by policy",
    message:
      `The host's scheduled task starts through wscript.exe, and the Windows Script Host Enabled=0 policy is set in ${disabledIn.join(" and ")}. ` +
      "The launcher never executes and nothing surfaces an error, so the host silently never starts at login. " +
      "Remove the policy (or have your administrator exempt this machine) to restore host auto-start.",
    fixAction: null,
    terminalCommand: `reg query "${disabledIn[0]}\\Software\\Microsoft\\Windows Script Host\\Settings" /v Enabled`,
    details: { disabledIn },
  };
}

async function probeWindowsCredentialsAcl(
  environment: Environment,
): Promise<DoctorIssue | null> {
  const credentialsPath = cliCredentialsPath(environment);
  try {
    await stat(credentialsPath);
  } catch {
    // No credentials file means nothing to probe.
    return null;
  }
  let stdout: string;
  try {
    stdout = execFileSync("icacls", [credentialsPath], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    return null;
  }
  // icacls prints lines like:
  //   C:\Users\me\.traycer\cli\credentials NT AUTHORITY\SYSTEM:(F)
  //                                         BUILTIN\Administrators:(F)
  //                                         DOMAIN\me:(F)
  // We accept owner-only + the conventional SYSTEM / Administrators
  // anchors and flag anything else with read (R) or full (F) access.
  const acceptedPrincipals = [
    /\\SYSTEM(?::|\s|$)/i,
    /\\Administrators(?::|\s|$)/i,
    new RegExp(
      `\\\\${(process.env.USERNAME ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?::|\\s|$)`,
      "i",
    ),
  ];
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  const permissive: string[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    if (!line.includes(":(")) continue;
    if (acceptedPrincipals.some((re) => re.test(line))) continue;
    permissive.push(line);
  }
  if (permissive.length === 0) return null;
  return {
    code: DOCTOR_ISSUE_CODES.WINDOWS_CREDENTIALS_ACL_PERMISSIVE,
    severity: "warning",
    title: "Credentials file has non-owner read access (Windows)",
    message: `${credentialsPath} grants access to principals beyond the file owner / SYSTEM. On a shared or VDI machine those principals can read the bearer token. Use icacls to remove the unexpected grants, or move the file to a per-user profile location.`,
    fixAction: null,
    terminalCommand: null,
    details: { credentialsPath, permissivePrincipals: permissive },
  };
}

function parseWebsocketPort(
  url: string,
): { readonly host: string; readonly port: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const port = Number(parsed.port);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: parsed.hostname || "127.0.0.1", port };
}

function probeWebsocketUrl(url: string): Promise<boolean> {
  // ws://host:port/path → just probe the TCP socket. Doctor doesn't
  // need a full handshake to know whether the endpoint is alive.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve(false);
  }
  const port = Number(parsed.port);
  const host = parsed.hostname || "127.0.0.1";
  if (!Number.isFinite(port) || port <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const socket: Socket = connect(port, host);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

// Exercise the *real* authenticated RPC path (the cheap, no-arg
// `host.status`) so doctor catches the WS-handshake / auth / protocol
// failures a TCP probe is blind to - the layer where "Desktop can't
// connect" actually lives. Returns null when the round-trip succeeds.
// Never throws: a probe failure becomes a DoctorIssue, never a doctor
// crash.
async function probeHostRpc(
  endpoint: HostTransportEndpoint,
  environment: Environment,
): Promise<DoctorIssue | null> {
  const { websocketUrl } = endpoint;
  const auth = await resolveHostAuth();
  if (auth === null) {
    // Without a bearer we can't verify the authenticated path. Don't claim
    // healthy (TCP-open ≠ usable) nor broken - surface as info.
    return {
      code: DOCTOR_ISSUE_CODES.HOST_RPC_UNVERIFIED,
      severity: "info",
      title: "Host connection not fully verified (not signed in)",
      message:
        "The host's port is open, but verifying the authenticated RPC connection the app uses requires sign-in.",
      fixAction: null,
      terminalCommand: "traycer login",
      details: { websocketUrl },
    };
  }
  try {
    await callHostRpcAtEndpoint("host.status", {}, endpoint);
    return null;
  } catch (err) {
    if (err instanceof HostRpcError) {
      if (err.code === "UNAUTHORIZED") {
        return {
          code: DOCTOR_ISSUE_CODES.HOST_RPC_UNAUTHORIZED,
          severity: "error",
          title: "Host rejected the stored credentials",
          message:
            "The host is listening but rejected the authenticated RPC connection (UNAUTHORIZED) even after a bearer refresh. Sign in again.",
          fixAction: null,
          terminalCommand: "traycer login",
          details: { websocketUrl, rpcCode: err.code },
        };
      }
      if (err.code === "INCOMPATIBLE" || err.code === "DOWNGRADE_UNSUPPORTED") {
        return incompatibleRpcIssue(websocketUrl, err, environment);
      }
      // RPC_ERROR / transport: the port accepted a TCP connection but the
      // RPC layer didn't answer (wedged listener, dial/frame timeout).
      return {
        code: DOCTOR_ISSUE_CODES.PORT_UNREACHABLE,
        severity: "error",
        title: "Host endpoint not answering RPC",
        message: `The host's port is open but it did not complete an RPC handshake (${err.code}). Restart the service.`,
        fixAction: "host-restart",
        terminalCommand: "traycer host restart",
        details: { websocketUrl, rpcCode: err.code },
      };
    }
    return {
      code: DOCTOR_ISSUE_CODES.PORT_UNREACHABLE,
      severity: "warning",
      title: "Host RPC probe failed",
      message: `Could not complete an RPC handshake with the host: ${
        err instanceof Error ? err.message : String(err)
      }`,
      fixAction: "host-restart",
      terminalCommand: "traycer host restart",
      details: { websocketUrl },
    };
  }
}

// Route a handshake `INCOMPATIBLE` (or cross-major `DOWNGRADE_UNSUPPORTED`) to
// the vector-aware recovery (C2). The frame's `upgradeGuidance` tells us which
// side is stale; the install vector (from the CLI manifest) tells us how to
// update this client. The action is driven off the resolver's
// `reinstallHost` flag (NOT re-derived here): whenever the host is stale -
// host-only OR mutual - the fix is the renderer's existing
// `host-install-latest` (reinstall the latest host, `traycer host
// update`), and any client-side staleness rides along as copy in the summary
// (no auto-fix button - the CLI must not self-replace a package-manager-owned
// binary). A client-only verdict offers no button; a no-stale-side verdict
// falls back to a host restart. This matters under the softened production
// trigger: an ordinary launch no longer auto-updates, so a genuinely-stale
// host must be routed to an UPDATE, not an ineffective restart loop.
async function incompatibleRpcIssue(
  websocketUrl: string | null,
  err: HostRpcError,
  environment: Environment,
): Promise<DoctorIssue> {
  const source = await readInstallSource(environment);
  const routing = routeIncompatibleRecovery(
    err.code,
    err.fatalDetails?.upgradeGuidance ?? null,
    source,
  );

  // AN EPOCH REJECTION WINS over the guidance-derived summary, and resolves the
  // remedy through the install vector's own mechanism. `routing.plan.summary`
  // answers "which side is stale" from two booleans; the host has already
  // answered that and gone further - it named the generation it needs - so
  // restating the vaguer answer beside it would be printing the worse of two.
  //
  // The `manual` vector is the only one that reaches the network here (see
  // `clientCompatibilityRecoveryHintForVector`), and it cannot throw: an
  // unreachable feed degrades the advice rather than replacing a compatibility
  // rejection with a registry error.
  const epochHint = await clientCompatibilityRecoveryHintForVector({
    requirement: err.fatalDetails?.clientCompatibilityRequirement ?? null,
    source,
    readFeedEpoch: readCliFeedCompatibilityEpoch,
  });

  return {
    code: DOCTOR_ISSUE_CODES.HOST_RPC_INCOMPATIBLE,
    severity: "error",
    title: "Host/CLI protocol mismatch",
    message:
      epochHint === null
        ? `The host is reachable but its RPC protocol is incompatible with this client. ${routing.plan.summary}`
        : `The host is reachable but ${epochHint}.`,
    fixAction: routing.fixAction,
    terminalCommand: routing.terminalCommand,
    details: {
      websocketUrl,
      rpcCode: err.code,
      installSource: source,
      hostShouldUpgrade: routing.plan.reinstallHost,
      clientShouldUpgrade: routing.plan.clientUpgrade !== null,
    },
  };
}

export interface IncompatibleRecoveryRouting {
  readonly fixAction: "host-install-latest" | "host-restart" | null;
  readonly terminalCommand: string | null;
  readonly plan: CompatRecoveryPlan;
}

// Pure routing for a handshake `INCOMPATIBLE` / cross-major
// `DOWNGRADE_UNSUPPORTED` verdict. Exported so the action mapping is unit-
// testable without standing up the WS/filesystem probes.
//
// The action is driven off the resolver's `reinstallHost` flag (NOT
// re-derived per-case): whenever the host is stale - host-only OR mutual -
// the fix is the renderer's existing `host-install-latest` (`traycer host
// update`), and any client-side staleness rides along as copy in the summary
// (no auto-fix button - the CLI must not self-replace a package-manager-owned
// binary). A client-only verdict offers no button; a no-stale-side verdict
// falls back to a host restart.
//
// `DOWNGRADE_UNSUPPORTED` is thrown by the client transport with
// `fatalDetails: null` when this client is NEWER than the host and no
// downgrade bridge exists for the called method (ws-rpc-client.ts) -
// client-newer ⇒ the host is the stale side ⇒ it must UPDATE, not restart.
// We synthesize a host-should-upgrade verdict for it instead of letting the
// null guidance fall through to a restart that, under the softened production
// trigger (ordinary launches no longer auto-update), would never heal it.
export function routeIncompatibleRecovery(
  rpcCode: string,
  upgradeGuidance: IncompatibilityUpgradeGuidance | null,
  source: CliInstallSource,
): IncompatibleRecoveryRouting {
  const plan = resolveCompatRecovery(
    effectiveUpgradeGuidance(rpcCode, upgradeGuidance),
    source,
  );

  const fixAction = plan.reinstallHost
    ? "host-install-latest"
    : plan.clientUpgrade !== null
      ? null
      : "host-restart";
  const terminalCommand =
    fixAction === "host-install-latest"
      ? "traycer host update"
      : fixAction === "host-restart"
        ? "traycer host restart"
        : null;
  return { fixAction, terminalCommand, plan };
}

// Reads the host's sticky needs-reauth marker.
//
// PRESENCE of the marker is the verdict, on its own. The tempting stronger
// test - marker AND credential file - is nearly unsatisfiable and would make
// this probe dead code: the host DELETES the credential and then writes the
// marker, so the two coexist only when that delete failed, which the host
// already self-repairs at its next startup. In the state this probe is for,
// the credential file is gone and the marker is the only thing left.
//
// The marker's own lifecycle is what makes reporting it safe: it is cleared by
// every successful adopt/refresh, so it can only be found set while the host
// genuinely still needs a fresh provisioning.
//
// PRESENT-BUT-UNREADABLE IS STILL PRESENT. Tolerating a truncated, hand-edited
// or permission-denied marker means "do not crash", not "report clean" - the
// file existing is the verdict, and its contents are only diagnostics. Reading
// a malformed marker as absent inverted exactly the contract stated above and
// hid the fault it exists to surface, so only ENOENT is clean; anything else
// present reports the issue with `unknown` diagnostics.
//
// Never throws - doctor probes are advisory and must not take the whole report
// down.
async function probeHostCredentialNeedsReauth(
  environment: Environment,
): Promise<DoctorIssue | null> {
  const markerPath = hostNeedsReauthPath(environment);
  let raw: string | null;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isFileNotFoundError(err)) {
      // The only clean answer: this host has no burn on record.
      return null;
    }
    // A read that failed for some reason OTHER than "not there" used to be
    // read as "present but unreadable", i.e. as a burn. That inference needs
    // the marker's PARENT to have been inspectable, and it silently assumed
    // so: on a host whose auth directory is unsearchable, `readFile` answers
    // EACCES whether or not the file exists, so doctor asserted a burned
    // credential over a directory that may well be empty - and pointed the
    // reader at re-provisioning, which cannot fix a permission.
    const parent = await probeAuthDirectory(dirname(markerPath));
    if (parent === "absent") {
      // No directory, so no marker inside it. Clean, for the same reason
      // ENOENT on the file itself is.
      return null;
    }
    if (parent === "unprobeable") {
      return authDirectoryInaccessibleIssue(dirname(markerPath));
    }
    // Parent is a directory we can search, so the failure really is about
    // this file: something is there and we cannot read it. Report the burn.
    raw = null;
  }
  try {
    const marker = parseMarkerFields(raw);
    const reason = marker.reason;
    const recordedAt = marker.recordedAt;
    const credentialPresent = await access(
      hostCredentialPath(environment),
    ).then(
      () => true,
      () => false,
    );
    return {
      code: DOCTOR_ISSUE_CODES.HOST_CREDENTIAL_NEEDS_REAUTH,
      severity: "error",
      title: "Host credential needs re-authorization",
      message:
        `This host's own delegated credential was rejected in a way refreshing cannot repair (${reason}, recorded ${recordedAt}), ` +
        "so the host stopped using it. Until it is replaced, work the host does on your behalf - opening Tasks, notifications, shared artifacts - can fail with sign-in-looking errors that signing in again does not fix. " +
        "To replace it, open the Traycer desktop app while signed in as this host's owner and let it connect: a connected owner client provisions a new credential on its own, with nothing to confirm and nothing to run here.",
      // NEITHER a fix action NOR a terminal command, and for the same reason:
      // nothing on a command line repairs this. A connected owner client mints
      // the replacement silently, so the instruction has to live in the
      // MESSAGE - which is why the message carries it explicitly. With both
      // action fields null, this text is the entire recovery path the CLI
      // report and Desktop's issue card have to offer; a message that only
      // rules out signing in again leaves the reader with a dead end.
      //
      // `terminalCommand` was `traycer login`, which reads as a repair and is
      // not one: signing the HUMAN in again does not provision the HOST's
      // delegated credential, which is the whole distinction this issue
      // exists to draw. Desktop's failure card renders "Open in Terminal"
      // whenever this is non-null (`host-doctor-issue-card.tsx`), so leaving
      // it set offered a button that could only look like it had failed.
      fixAction: null,
      terminalCommand: null,
      details: {
        markerPath,
        reason,
        recordedAt,
        // True only in the delete-failed shape above. Carried because a
        // support bundle wants to know which of the two it is looking at.
        credentialFilePresent: credentialPresent,
        // Distinguishes "the host told us why" from "a marker is there and we
        // could not read it" - the two lead to the same verdict but not to the
        // same support conversation.
        markerReadable: raw !== null && reason !== UNKNOWN_MARKER_FIELD,
      },
    };
  } catch {
    // Nothing above should throw, but a probe that cannot answer must not be
    // the reason `doctor` fails.
    return null;
  }
}

const UNKNOWN_MARKER_FIELD = "unknown";

/**
 * Whether the directory holding the needs-reauth marker can be inspected at
 * all, which is the precondition the marker probe's verdict rests on.
 *
 * `R_OK | X_OK` because the two failures are different and both matter: a
 * directory without SEARCH permission makes every `readFile` inside it EACCES
 * regardless of what it contains, which is exactly the state that turns
 * "unreadable file" into a false burn. The `isDirectory` check is not
 * ceremony either - a regular file standing where the auth directory belongs
 * passes `access` happily while every path under it is ENOTDIR, so access
 * alone would call that state probeable and re-create the same wrong verdict
 * through a different door.
 *
 * Plane-agnostic despite the name (it takes the directory): the identity-plane
 * probe below asks the same question about its own marker's parent, and the
 * two planes must not answer "can I look here?" differently.
 *
 * Never throws.
 */
async function probeAuthDirectory(
  dirPath: string,
): Promise<"ok" | "absent" | "unprobeable"> {
  try {
    await access(dirPath, fsConstants.R_OK | fsConstants.X_OK);
  } catch (err) {
    return isFileNotFoundError(err) ? "absent" : "unprobeable";
  }
  try {
    const info = await stat(dirPath);
    return info.isDirectory() ? "ok" : "unprobeable";
  } catch (err) {
    return isFileNotFoundError(err) ? "absent" : "unprobeable";
  }
}

/**
 * The INDETERMINATE answer: doctor could not look, and says so.
 *
 * Deliberately not `HOST_CREDENTIAL_NEEDS_REAUTH`. That code asserts a burn
 * and names a repair - open the app and let it re-provision - which does
 * nothing for a directory the host cannot read. Reporting it here would send
 * someone to fix a credential over a filesystem permission, and the fix they
 * were told to apply would appear not to work.
 */
function authDirectoryInaccessibleIssue(dirPath: string): DoctorIssue {
  return {
    code: DOCTOR_ISSUE_CODES.HOST_AUTH_DIR_INACCESSIBLE,
    severity: "warning",
    title: "Cannot inspect this host's credential state",
    message:
      `This host's auth directory (${dirPath}) could not be read, so doctor cannot tell whether the host's own delegated credential is healthy or was burned. ` +
      "Check the directory's ownership and permissions - it should be readable and searchable by the user the host runs as. " +
      "This is not itself a credential fault; it means this one check could not run.",
    fixAction: null,
    terminalCommand: null,
    details: { authDirPath: dirPath },
  };
}

/**
 * Best-effort read of the marker's diagnostic fields. A `null` body (unreadable
 * file) or unparseable/incomplete JSON yields `unknown` rather than changing
 * the verdict - the verdict was already decided by the file existing.
 */
function parseMarkerFields(raw: string | null): {
  readonly reason: string;
  readonly recordedAt: string;
} {
  if (raw === null) {
    return { reason: UNKNOWN_MARKER_FIELD, recordedAt: UNKNOWN_MARKER_FIELD };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: UNKNOWN_MARKER_FIELD, recordedAt: UNKNOWN_MARKER_FIELD };
  }
  const marker = isRecord(parsed) ? parsed : {};
  return {
    reason:
      typeof marker.reason === "string" && marker.reason.length > 0
        ? marker.reason
        : UNKNOWN_MARKER_FIELD,
    recordedAt:
      typeof marker.recordedAt === "string" && marker.recordedAt.length > 0
        ? marker.recordedAt
        : UNKNOWN_MARKER_FIELD,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ENOENT - the file genuinely is not there, as opposed to unreadable. */
function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

// ---- Identity plane ------------------------------------------------------ //

// Reads the host's IDENTITY-plane needs-reauth marker, and is honest about
// what reading it can and cannot settle.
//
// Everything above this line is the AUTH plane: the host's own delegated
// credential under `<host home>/auth/`, which a connected owner client
// re-provisions. This marker lives under `<identity home>/identity/` and means
// something else - the host's coordination identity paused after a credential
// refresh was rejected - and it clears when a user bearer NEWER than the
// marker lands in the shared CLI credentials file, i.e. when somebody signs in
// again here. Two planes, two markers of the same name, opposite repairs.
//
// WHY THIS ONE CANNOT REPORT CLEAN. A host resolves its identity home as
// `devIdentityHomeOverride ?? <host home>`, and the override is installed
// inside the host process by the dev identity pool walk - not in a file, not
// in an env var this CLI is spawned with, not derivable from any path here. On
// a pool machine the marker this probe is looking for may sit under
// `~/.traycer/host/dev/identities/<name>/identity/`, and which `<name>` a
// running host took is knowledge that exists only in that process. An
// ENOENT-is-clean probe would therefore report a stranded dev-pool host as
// healthy, which is the environment the original incident was filed from.
//
// So the answer is scoped rather than asserted: a marker found here is
// reported, a marker that cannot be found here is reported as NOT VERIFIED
// whenever this host could actually have taken a pool identity (see
// `identityHomeUnverifiedIssue` for the two negatives that rule that out),
// and the host's own `host.doctor` - the only party that resolves the live
// identity home - substitutes its own verdict for every code this function
// emits.
//
// Never throws; doctor probes are advisory and must not take the report down.
async function probeHostIdentityNeedsReauth(
  environment: Environment,
  hostProcessAlive: boolean,
): Promise<DoctorIssue | null> {
  const markerPath = hostIdentityNeedsReauthPath(environment);
  const identityDirPath = dirname(markerPath);
  try {
    let raw: string | null;
    try {
      raw = await readFile(markerPath, "utf8");
    } catch (err) {
      if (isFileNotFoundError(err)) {
        return await identityHomeUnverifiedIssue(
          environment,
          markerPath,
          identityDirPath,
          hostProcessAlive,
        );
      }
      const parent = await probeAuthDirectory(identityDirPath);
      if (parent === "absent") {
        // No identity directory, so no marker inside it - as unremarkable as
        // ENOENT on the file, and scoped the same way.
        return await identityHomeUnverifiedIssue(
          environment,
          markerPath,
          identityDirPath,
          hostProcessAlive,
        );
      }
      if (parent === "unprobeable") {
        return identityDirectoryInaccessibleIssue(identityDirPath);
      }
      // Searchable directory, unreadable file: something is there. Present is
      // the verdict; the contents were only ever diagnostics.
      raw = null;
    }
    const marker = parseIdentityMarkerFields(raw);
    return {
      code: DOCTOR_ISSUE_CODES.HOST_IDENTITY_NEEDS_REAUTH,
      severity: "error",
      title: "Host identity needs re-authorization",
      message:
        `The host identity in ${identityDirPath} is paused: a credential refresh was rejected without a revoke (${marker.reason}, since ${marker.since}), so the host stopped re-enrolling and its remote plane - relay attach, cloud-linked Tasks, anything that needs this machine reachable from outside - stays down until the pause lifts. ` +
        "It lifts on its own as soon as a user bearer NEWER than that marker reaches the shared CLI credentials file: run `traycer login` on this machine, or sign in from the Traycer app here, and the host re-enrolls itself. " +
        "This is NOT the host's own delegated credential (HOST_CREDENTIAL_NEEDS_REAUTH), which a connected owner client re-provisions and signing in again does not repair. If both are reported they are two separate faults, each needing its own repair. " +
        "Scope: this is the DEFAULT identity home. A host that acquired a dev-pool identity home resolves a different one in-process, so its own `host.doctor` is the authority on whether this marker is the one it is holding.",
      fixAction: null,
      // Unlike the auth plane, a sign-in IS the repair here: the pause watches
      // the CLI login file for a bearer issued after the marker. Desktop
      // renders "Open in Terminal" for a non-null command, and here that
      // button does the thing the card describes.
      terminalCommand: `traycer login`,
      details: {
        markerPath,
        identityDirPath,
        reason: marker.reason,
        since: marker.since,
        // "The host told us why" vs "a marker is there and we could not read
        // it" - one verdict, two different support conversations.
        markerReadable: raw !== null && marker.reason !== UNKNOWN_MARKER_FIELD,
        // Both markers share a filename; this is what keeps a support bundle
        // from confusing them.
        plane: "identity",
        // This probe reads one location and never claims to have read the
        // live one.
        scope: "default-identity-home",
        authoritative: false,
      },
    };
  } catch {
    // Nothing above should throw, but a probe that cannot answer must not be
    // the reason `doctor` fails.
    return null;
  }
}

/**
 * The scope caption: no marker in the default identity home, and what that is
 * worth.
 *
 * `null` - genuine silence - whenever the pool walk that installs an identity
 * override could not have run, because then the absence just read IS the whole
 * answer. Two independent negatives establish that, and each one alone is
 * enough:
 *
 * 1. THE ENVIRONMENT IS NOT `dev`. The host's own gate opens with
 *    `config.environment !== "dev" -> not-applicable`
 *    (`lifecycle/dev-identity-pool.ts`), so a production host always falls
 *    back to its own host home no matter what the pool contains. Spelled
 *    `!== "dev"` rather than `=== "production"` to mirror that gate exactly:
 *    `Environment` is an open string alias, and a future slot must be
 *    ineligible until something deliberately makes it eligible. Without this,
 *    one developer's internal `make dev-desktop` pool would caption every
 *    PRODUCTION doctor run on their machine forever - false uncertainty about
 *    a home that process cannot use, which is the same noise this gate exists
 *    to avoid, only pointed the other way.
 * 2. THERE IS NO POOL. With no identity seated under
 *    {@link hostDevIdentityPoolRoot}, no host here can hold an overridden
 *    identity home even on a dev build.
 *
 * What is deliberately NOT mirrored is the host's second gate,
 * `isEffectiveHomeCanonical()`. It reads the host's EFFECTIVE home, which
 * honours a `--host-data-dir` this CLI cannot see: a dev host launched
 * manually into a non-canonical directory looks canonical from here while
 * being fully pool-eligible. Suppressing on a canonical-looking dev home would
 * therefore report exactly that host clean, so `dev` stays conservative.
 *
 * The pool root is read for EXISTENCE, never attributed: which identity a
 * running host took is not recorded anywhere this CLI can see.
 */
async function identityHomeUnverifiedIssue(
  environment: Environment,
  markerPath: string,
  identityDirPath: string,
  hostProcessAlive: boolean,
): Promise<DoctorIssue | null> {
  if (environment !== "dev") {
    return null;
  }
  const poolRoot = hostDevIdentityPoolRoot();
  if (!(await devIdentityPoolExists(poolRoot))) {
    return null;
  }
  const authority = hostProcessAlive
    ? "A host process is running on this machine and resolves its own identity home, so its `host.doctor` answers this definitively - read that report (the Traycer app's host Doctor asks the host directly) rather than this line."
    : "No host process is running on this machine, so the authoritative check could not run at all. Start the host and re-run doctor through it for a definitive answer.";
  return {
    code: DOCTOR_ISSUE_CODES.HOST_IDENTITY_HOME_UNVERIFIED,
    severity: "info",
    title: "Host identity state not verified here",
    message:
      `No identity-plane re-auth marker in the default identity home (${identityDirPath}) - but this machine has a dev identity pool (${poolRoot}), and a host that acquired an identity from it keeps its marker under that identity's own home instead. ` +
      "This check reads the default location only, so its silence is not a clean bill of health for the identity plane. " +
      authority,
    // Nothing to press and nothing to copy: this is a statement about
    // coverage, not a fault with a repair.
    fixAction: null,
    terminalCommand: null,
    details: {
      probedMarkerPath: markerPath,
      probedIdentityDirPath: identityDirPath,
      devIdentityPoolRoot: poolRoot,
      // The eligibility fact this caption rests on - a support bundle should
      // not have to infer why the caption is here rather than absent.
      environment,
      hostProcessAlive,
      plane: "identity",
      scope: "default-identity-home",
      authoritative: false,
    },
  };
}

/**
 * Whether a dev identity pool exists on this machine - one `readdir`, existence
 * only.
 *
 * An empty pool root counts as no pool: the directory can outlive every
 * identity in it, and a pool with nothing in it cannot have given a host an
 * identity home. A readdir that fails for any reason OTHER than "not there"
 * counts as a pool, because the caller's silence is the unsafe direction: this
 * function exists to decide whether the CLI may stay quiet, and "I could not
 * tell" must not resolve to quiet.
 */
async function devIdentityPoolExists(poolRoot: string): Promise<boolean> {
  try {
    const entries = await readdir(poolRoot, { withFileTypes: true });
    return entries.some(
      (entry) => entry.isDirectory() || entry.isSymbolicLink(),
    );
  } catch (err) {
    return !isFileNotFoundError(err);
  }
}

/**
 * The identity plane's "could not look", kept separate from
 * {@link authDirectoryInaccessibleIssue} for the reason both exist: an issue
 * that names a repair must name the one that applies. This is a permission on
 * a different directory belonging to a different plane, and it is also NOT the
 * scope caption above - that one means "I looked and found nothing here", this
 * one means "I could not look".
 */
function identityDirectoryInaccessibleIssue(dirPath: string): DoctorIssue {
  return {
    code: DOCTOR_ISSUE_CODES.HOST_IDENTITY_DIR_INACCESSIBLE,
    severity: "warning",
    title: "Cannot inspect this host's identity state",
    message:
      `This host's identity directory (${dirPath}) could not be read, so doctor cannot tell whether the host's coordination identity is healthy or paused waiting for a fresh sign-in. ` +
      "Check the directory's ownership and permissions - it should be readable and searchable by the user the host runs as. " +
      "This is not itself an identity fault; it means this one check could not run.",
    fixAction: null,
    terminalCommand: null,
    details: { identityDirPath: dirPath, plane: "identity" },
  };
}

/**
 * Best-effort read of the identity marker's diagnostic fields. Separate from
 * {@link parseMarkerFields} because the two markers do not agree on their
 * field names - the identity plane stamps `since`, the auth plane
 * `recordedAt` - and reusing one reader would silently report `unknown` for
 * whichever plane it was not written for.
 */
function parseIdentityMarkerFields(raw: string | null): {
  readonly reason: string;
  readonly since: string;
} {
  if (raw === null) {
    return { reason: UNKNOWN_MARKER_FIELD, since: UNKNOWN_MARKER_FIELD };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reason: UNKNOWN_MARKER_FIELD, since: UNKNOWN_MARKER_FIELD };
  }
  const marker = isRecord(parsed) ? parsed : {};
  return {
    reason:
      typeof marker.reason === "string" && marker.reason.length > 0
        ? marker.reason
        : UNKNOWN_MARKER_FIELD,
    since:
      typeof marker.since === "string" && marker.since.length > 0
        ? marker.since
        : UNKNOWN_MARKER_FIELD,
  };
}

// Detects the "file is both there and not found" field shape: the CLI
// manifest's binaryPath is a symlink whose target no longer exists, so
// lstat (and `ls`) succeed while exec fails ENOENT. Never throws -
// doctor probes are advisory, and an unreadable manifest or a healthy
// binary both read as "nothing to report".
async function probeDanglingCliSlotBinary(
  environment: Environment,
): Promise<DoctorIssue | null> {
  try {
    const manifest = await readCliManifest(environment);
    if (manifest === null) return null;
    const linkStat = await lstat(manifest.binaryPath);
    if (!linkStat.isSymbolicLink()) return null;
    try {
      await stat(manifest.binaryPath);
      return null;
    } catch {
      // stat follows the link; failure after a successful lstat on a
      // symlink is the dangling shape this probe exists to name.
    }
    const target = await readlink(manifest.binaryPath).catch(() => "unknown");
    const repairAdvice =
      manifest.source === "desktop"
        ? "Launch the Traycer Desktop app to repair it (the app re-stages its bundled CLI at startup); if the app has been uninstalled, reinstall it, or remove the link and reinstall the CLI another way."
        : "Reinstall the CLI, or remove the dangling link.";
    return {
      code: DOCTOR_ISSUE_CODES.CLI_SLOT_BINARY_DANGLING,
      severity: "warning",
      title: "CLI binary is a dangling symlink",
      message:
        `The CLI at ${manifest.binaryPath} is a symlink to ${target}, which no longer exists: ` +
        "listing the file succeeds but executing it fails with 'no such file or directory'. " +
        repairAdvice,
      fixAction: null,
      terminalCommand: null,
      details: {
        binaryPath: manifest.binaryPath,
        linkTarget: target,
        installSource: manifest.source,
      },
    };
  } catch {
    return null;
  }
}

// Best-effort install-vector read for recovery routing. A missing or malformed
// CLI manifest defaults to `manual` (the safe "you own the binary" vector)
// rather than throwing - Doctor never crashes on a probe.
async function readInstallSource(
  environment: Environment,
): Promise<CliInstallSource> {
  try {
    const manifest = await readCliManifest(environment);
    return manifest?.source ?? "manual";
  } catch {
    return "manual";
  }
}
