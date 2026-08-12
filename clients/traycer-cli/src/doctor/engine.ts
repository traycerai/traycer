import { execFileSync } from "node:child_process";
import { access, lstat, readlink, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { cliCredentialsPath } from "../store/paths";
import {
  pendingUpgradeFinalisable,
  readPendingCliUpgrade,
} from "../commands/cli-upgrade";
import { reconcilePostFinalizeMarker } from "../upgrade/finalize-helper";
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
  resolveCompatRecovery,
  type CompatRecoveryPlan,
} from "../host/compat-recovery";
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
        terminalCommand: `traycer host install latest`,
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
      terminalCommand: `traycer host install latest`,
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
      terminalCommand: `traycer host install latest`,
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
  // First, fold in any marker the detached finalize helper wrote on a
  // prior restart cycle. If the helper succeeded, this clears
  // pendingUpgrade in the manifest, so the subsequent read returns
  // null and Doctor reports "no pending upgrade" - matching reality
  // even before the user runs another `traycer host restart`.
  // Reconcile is idempotent and safe on the no-marker path.
  await reconcilePostFinalizeMarker({ environment: opts.environment });

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
  if (pendingUpgrade !== null) {
    const stagedExists = await pendingUpgradeFinalisable({
      stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
    });
    if (!stagedExists) {
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
          "is no longer on disk. Re-run 'traycer cli upgrade' to re-stage.",
        fixAction: null,
        terminalCommand: `traycer cli upgrade`,
        details: {
          stagedVersion: pendingUpgrade.pending.version,
          stagedBinaryPath: pendingUpgrade.pending.stagedBinaryPath,
          stagedAt: pendingUpgrade.pending.stagedAt,
          reason: pendingUpgrade.pending.reason,
          currentVersion: pendingUpgrade.currentVersion,
          binaryPath: pendingUpgrade.binaryPath,
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
  const recentMarkers = await readBootstrapMarkers(opts.environment, 20);
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

  return {
    code: DOCTOR_ISSUE_CODES.HOST_RPC_INCOMPATIBLE,
    severity: "error",
    title: "Host/CLI protocol mismatch",
    message: `The host is reachable but its RPC protocol is incompatible with this client. ${routing.plan.summary}`,
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
