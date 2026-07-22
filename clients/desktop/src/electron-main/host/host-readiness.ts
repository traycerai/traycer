import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import { HOST_READY_EXTENDED_TIMEOUT_MS } from "@traycer/protocol/host/lifecycle-constants";
import {
  canReachHostWebsocketUrl,
  isCurrentHostWebsocketUrl,
  sleep,
} from "./host-lifecycle";
import { readAgentLabelPid } from "./launchctl-agent-pid";
import { HOST_AGENT_LABEL } from "../app/host-login-item";
import { TraycerCliError } from "../cli/traycer-cli";

// Host-readiness + CLI-error helpers used by the post-auth host-ensure
// flow (ipc/host-ensure-ipc.ts). The CLI's `host ensure` can report
// success the moment the service is registered/started, but the OS service
// manager still has to spawn the host and have it publish its pid metadata
// + bind its WS port.
// We poll that on-disk source of truth before telling the renderer the
// host is ready, so the gate never flips to "ready" against a host that
// hasn't actually bound its port yet.

// Sized to absorb a slow shell init + native-module/Prisma load on first
// spawn (mirrors HostLifecycle.HOST_READY_TIMEOUT_MS).
export const HOST_READY_TIMEOUT_MS = 60_000;
export const HOST_READY_POLL_MS = 250;
// Re-export so ensure/callers share one constant with the protocol budget.
export { HOST_READY_EXTENDED_TIMEOUT_MS };

export interface HostReadinessResult {
  readonly ready: boolean;
  readonly version: string | null;
  readonly pid: number | null;
  readonly reason: string;
}

/**
 * Pre-action snapshot of host.log + pid.json used to decide readiness
 * extension / terminal fail-fast (Finding F). Captured before the start
 * or register action so post-baseline evidence is attributable to *this*
 * attempt. Identity-aware: records dev/inode + size, never a bare length
 * (log rotation lands `starting` at offset 0 of a fresh file).
 */
export interface HostSpawnEvidenceBaseline {
  readonly logPath: string;
  readonly logExists: boolean;
  readonly logSize: number;
  readonly logDev: number | null;
  readonly logIno: number | null;
  readonly pidPath: string;
  readonly pidExists: boolean;
  readonly pidMtimeMs: number | null;
  readonly pid: number | null;
  // Set only after CLI ensure returns. New-format markers earlier than this
  // cannot belong to its final Windows `/Run`; legacy markers retain baseline
  // correlation for compatibility with older supervisors.
  readonly markerAuthoritySinceMs: number | null;
}

/**
 * Darwin readiness authority (Finding F). The SMAppService cohort has no win32
 * spawn-evidence baseline; the ONLY authority for extending past the base
 * budget is a live agent-label pid via `launchctl print`. Post-baseline
 * terminal markers NEVER authorize an extension and fail-fast ONLY once the
 * agent generation is CONFIRMED GONE (launchctl yields no live agent pid across
 * consecutive probes); the newest OWNED marker (its `supervisorPid` was observed
 * under the agent label this attempt) is then the death reason. While launchctl
 * still yields a live pid the marker is subordinate - a superseded generation's
 * crash, or a throttle-cached pid that happens to match an older marker, must
 * never fail a live, recovering attempt (e.g. launchd KeepAlive crash-recovery).
 * (The legacy and agent labels exec the same `host start` into the same log, so
 * an UNOWNED terminal marker never fails an agent-label attempt - it only
 * decorates the generic timeout with a diagnostic hint.)
 */
export interface DarwinAgentAuthority {
  readonly agentLabel: string;
  readonly readAgentLabelPid: (agentLabel: string) => Promise<number | null>;
  // Log baseline for reading post-baseline terminal markers (reason strings +
  // ownership correlation only - never skip/extend authority).
  readonly terminalMarkerBaseline: HostSpawnEvidenceBaseline | null;
  // How often to re-check the live agent pid via `launchctl print`. Coarser
  // than the pid.json poll (each check spawns a subprocess). Carried on the
  // authority so tests can drive it deterministically.
  readonly probeIntervalMs: number;
  // Hold an owned-terminal-marker death verdict for this long past the first
  // confirmed miss, so a crashed agent's ONE launchd KeepAlive relaunch (no
  // sooner than the plist ThrottleInterval) can publish a fresh pid before the
  // wait fails onto an error card (Me-A). A live pid observed within the window
  // resets the miss run and extends instead. Carried on the authority so tests
  // can scale it against the probe cadence.
  readonly relaunchGraceMs: number;
}

export interface WaitForHostReadyOptions {
  // null disables win32 spawn-evidence extension / terminal fail-fast.
  readonly spawnEvidenceBaseline: HostSpawnEvidenceBaseline | null;
  // Absolute hard cap when extending past `timeoutMs` on post-baseline spawn
  // evidence (win32) or a live agent-label pid (darwin). Ignored when neither
  // a baseline nor a darwin authority is set.
  readonly extendedTimeoutMs: number;
  // Darwin SMAppService authority - mutually exclusive with
  // `spawnEvidenceBaseline` (the two cohorts never overlap).
  readonly darwinAgentAuthority: DarwinAgentAuthority | null;
}

// How often the darwin readiness path re-checks the live agent-label pid via
// `launchctl print`. Coarser than the pid.json poll (each check spawns a
// subprocess), fine enough to accumulate ownership evidence and bound the
// extension-death detection latency.
const DARWIN_AGENT_PROBE_INTERVAL_MS = 3_000;

// A single `launchctl print` miss is ambiguous: a subprocess timeout / transient
// launchd hiccup and a real "job not loaded" both surface as a null pid, and a
// crash→KeepAlive-relaunch leaves a brief no-pid gap between generations.
// Require this many CONSECUTIVE probe misses before treating the current agent
// generation as gone, so one transient null never fails a live, recovering
// attempt (Finding F). Two is the minimum that distinguishes a flap from a
// sustained absence; at DARWIN_AGENT_PROBE_INTERVAL_MS spacing that is a
// ~3-6s confirmation delay, negligible against the extended readiness budget.
const DARWIN_AGENT_MISS_CONFIRM_THRESHOLD = 2;

// launchd relaunches a crashed KeepAlive agent no sooner than the host plist's
// ThrottleInterval (scripts/prepack/inject-host-launch-agent.cjs: 10s). A
// transient early crash writes an OWNED terminal marker, and confirmed-gone
// (~6s) fires well before that one legal relaunch - so without a grace the wait
// fails onto an error card for a host launchd revives seconds later, and because
// the lifecycle event does not bump the readiness gate the recovery needs a
// manual Retry (Me-A).
const DARWIN_KEEPALIVE_THROTTLE_INTERVAL_MS = 10_000;
// Hold the owned-terminal-marker death verdict for one full relaunch window past
// the throttle: the throttle plus two probe intervals of slack so the relaunched
// pid is observed at the coarse launchctl cadence before the grace expires.
const DARWIN_KEEPALIVE_RELAUNCH_GRACE_MS =
  DARWIN_KEEPALIVE_THROTTLE_INTERVAL_MS + 2 * DARWIN_AGENT_PROBE_INTERVAL_MS;

export async function captureHostSpawnEvidenceBaseline(
  logPath: string,
  pidPath: string,
): Promise<HostSpawnEvidenceBaseline> {
  const [logStat, pidStat, pidSnapshot] = await Promise.all([
    statOrNull(logPath),
    statOrNull(pidPath),
    readPidMetadataForReady(pidPath),
  ]);
  return {
    logPath,
    logExists: logStat !== null,
    logSize: logStat === null ? 0 : logStat.size,
    logDev: logStat === null ? null : logStat.dev,
    logIno: logStat === null ? null : logStat.ino,
    pidPath,
    pidExists: pidStat !== null,
    pidMtimeMs: pidStat === null ? null : pidStat.mtimeMs,
    pid: pidSnapshot === null ? null : pidSnapshot.pid,
    markerAuthoritySinceMs: null,
  };
}

/**
 * Build the darwin SMAppService readiness authority (Finding F): the live
 * agent-label pid via `launchctl print`, plus a fresh log baseline used ONLY
 * for owned terminal-marker reasons (never skip/extend authority). Returns null
 * off the cohort (win32 / linux / dev), where `launchctl` and the agent label
 * have nothing to report and the win32 spawn-evidence baseline governs instead.
 * The `markerAuthoritySinceMs` stamp scopes terminal-marker reads to this
 * attempt; ownership (supervisor pid ∈ observed agent pids) is the real filter.
 */
export async function buildDarwinAgentAuthority(
  hostOwnsLoginItem: boolean,
  logPath: string,
  pidPath: string,
): Promise<DarwinAgentAuthority | null> {
  if (!hostOwnsLoginItem) return null;
  const baseline = await captureHostSpawnEvidenceBaseline(logPath, pidPath);
  return {
    agentLabel: HOST_AGENT_LABEL,
    readAgentLabelPid,
    terminalMarkerBaseline: {
      ...baseline,
      markerAuthoritySinceMs: Date.now(),
    },
    probeIntervalMs: DARWIN_AGENT_PROBE_INTERVAL_MS,
    relaunchGraceMs: DARWIN_KEEPALIVE_RELAUNCH_GRACE_MS,
  };
}

// Poll the environment-scoped pid metadata file until the host publishes a
// well-formed, reachable websocket URL or the timeout elapses. `pidPath`
// and `pollIntervalMs` are explicit so callers (and tests) control the
// filesystem dependency.
//
// `skipPid` is the respawn path's hook to distinguish the new host from
// the still-running old one: SMAppService's `unregister` is asynchronous
// to launchd's teardown, so for a brief window after we kick the cycle
// the old process is still bound to its port and its still-on-disk
// pid.json still validates. Passing the pre-respawn pid here makes the
// poll skip matching snapshots so we only return `ready` once the new
// host has actually published. Callers in the install/sign-in flow,
// where there cannot be a stale pid yet, pass `null`.
//
// When `options.spawnEvidenceBaseline` is set (win32), on base-budget
// expiry the poll extends up to `extendedTimeoutMs` if post-baseline
// spawn evidence is present (pid metadata / `starting` marker). A
// post-baseline terminal marker fails immediately with its reason.
export async function waitForHostReady(
  timeoutMs: number,
  pidPath: string,
  pollIntervalMs: number,
  skipPid: number | null,
  options: WaitForHostReadyOptions,
): Promise<HostReadinessResult> {
  const baseDeadline = Date.now() + timeoutMs;
  const hasExtensionAuthority =
    options.spawnEvidenceBaseline !== null ||
    options.darwinAgentAuthority !== null;
  const hardDeadline = hasExtensionAuthority
    ? Date.now() + options.extendedTimeoutMs
    : baseDeadline;
  let lastReason = "pid metadata never appeared";
  let extended = false;
  const markerReader =
    options.spawnEvidenceBaseline === null
      ? null
      : createPostBaselineMarkerReader(options.spawnEvidenceBaseline);

  // Darwin (Finding F): the live agent-label pid via `launchctl print` is the
  // SOLE authority. It is the only signal that extends past the base budget, and
  // a terminal marker fails-fast ONLY once launchctl yields no live pid (the
  // generation is confirmed gone); an owned marker then supplies the death reason
  // (`darwinOwnedTerminalReason`), while an unowned one only decorates the
  // generic timeout (`decorateWithUnownedTerminal`).
  const darwin = options.darwinAgentAuthority;
  const darwinTerminalBaseline = darwin?.terminalMarkerBaseline ?? null;
  const darwinMarkerReader =
    darwinTerminalBaseline === null
      ? null
      : createPostBaselineMarkerReader(darwinTerminalBaseline);
  const observedAgentPids = new Set<number>();
  let lastAgentPid: number | null = null;
  let nextAgentProbeAt = 0;
  // Consecutive `launchctl print` misses (see DARWIN_AGENT_MISS_CONFIRM_THRESHOLD).
  // Only updated on a REAL probe (not the throttled cached-value path), so it
  // counts probe intervals of sustained absence, not poll iterations.
  let consecutiveAgentPidMisses = 0;
  // When the current miss run began (first miss after the last live pid). Anchors
  // the KeepAlive relaunch grace (Me-A); reset the instant a live pid returns.
  let firstAgentPidMissAtMs: number | null = null;
  const darwinRelaunchGraceMs = darwin === null ? 0 : darwin.relaunchGraceMs;
  const probeDarwinAgentPid = async (nowMs: number): Promise<number | null> => {
    if (darwin === null) return null;
    if (nowMs < nextAgentProbeAt) return lastAgentPid;
    nextAgentProbeAt = nowMs + darwin.probeIntervalMs;
    const pid = await darwin.readAgentLabelPid(darwin.agentLabel);
    if (pid === null) {
      if (consecutiveAgentPidMisses === 0) firstAgentPidMissAtMs = nowMs;
      consecutiveAgentPidMisses += 1;
    } else {
      observedAgentPids.add(pid);
      consecutiveAgentPidMisses = 0;
      firstAgentPidMissAtMs = null;
    }
    lastAgentPid = pid;
    return pid;
  };
  // The current agent generation counts as gone only after the confirmation
  // threshold of consecutive misses - never on a single transient null (a
  // launchctl hiccup or the crash→relaunch gap). This gates every darwin
  // fail path that keys off "no live pid".
  const agentGenerationConfirmedGone = (): boolean =>
    lastAgentPid === null &&
    consecutiveAgentPidMisses >= DARWIN_AGENT_MISS_CONFIRM_THRESHOLD;
  // Confirmed gone AND launchd's one throttled KeepAlive relaunch window has
  // elapsed with no fresh pid (Me-A). Holding the death verdict this long lets a
  // transient early crash self-heal (a relaunch resets the miss run above and
  // extends) instead of failing readiness onto an error card for a host that
  // revives seconds later. An EX_CONFIG-style pre-JS crash writes no OWNED
  // marker, so it never rides this path and keeps its fail-fast at the deadline.
  const agentGenerationDeadPastRelaunchGrace = (nowMs: number): boolean =>
    agentGenerationConfirmedGone() &&
    firstAgentPidMissAtMs !== null &&
    nowMs - firstAgentPidMissAtMs >= darwinRelaunchGraceMs;

  // Post-baseline terminal markers within this attempt's authority window.
  const readDarwinTerminalMarkers = async (): Promise<
    readonly ParsedMarker[]
  > => {
    if (darwinMarkerReader === null) return [];
    return (await darwinMarkerReader.read()).filter((marker) =>
      darwinTerminalBaseline === null
        ? true
        : isMarkerInAuthorityWindow(marker, darwinTerminalBaseline),
    );
  };
  // The reason from the newest OWNED terminal marker: its supervisor pid was
  // observed under the agent label this attempt (never a forgeable legacy-label
  // start's pid). Consulted ONLY once the agent generation is CONFIRMED GONE, so
  // the newest owned marker is the death reason of the generation that just ran.
  // While launchctl still yields a live agent pid the caller never asks - the
  // live pid is the sole authority (LANDMINE), so a marker can never fail a live,
  // recovering attempt, and there is no pid-identity match against the
  // (throttle-cached, possibly stale) probe value that a superseded crash could
  // ride in on (Finding F / launchd KeepAlive crash-recovery).
  const darwinOwnedTerminalReason = async (): Promise<string | null> => {
    if (observedAgentPids.size === 0) return null;
    const markers = await readDarwinTerminalMarkers();
    for (let i = markers.length - 1; i >= 0; i -= 1) {
      const marker = markers[i];
      if (marker === undefined || !TERMINAL_PHASES.has(marker.phase)) continue;
      const supervisorPid = Number.parseInt(
        marker.fields.supervisorPid ?? "",
        10,
      );
      if (
        Number.isInteger(supervisorPid) &&
        observedAgentPids.has(supervisorPid)
      ) {
        return terminalMarkerReason(marker);
      }
    }
    return null;
  };
  // The newest UNOWNED terminal marker's reason: a supervisor pid never observed
  // under the agent label (a legacy-label start's crash into the shared log) or
  // an unattributable marker. Used ONLY to decorate a generic timeout as a
  // diagnostic hint. Deliberately EXCLUDES owned markers: an owned marker is
  // either authoritative (surfaced by `darwinOwnedTerminalReason` when the
  // generation is gone) or superseded by a live newer pid - and decorating a
  // live-but-slow generation's timeout with a superseded crash reason would
  // misattribute its cause (Finding F review).
  const darwinUnownedTerminalReason = async (): Promise<string | null> => {
    const markers = await readDarwinTerminalMarkers();
    for (let i = markers.length - 1; i >= 0; i -= 1) {
      const marker = markers[i];
      if (marker === undefined || !TERMINAL_PHASES.has(marker.phase)) continue;
      const supervisorPid = Number.parseInt(
        marker.fields.supervisorPid ?? "",
        10,
      );
      if (
        !Number.isInteger(supervisorPid) ||
        !observedAgentPids.has(supervisorPid)
      ) {
        return terminalMarkerReason(marker);
      }
    }
    return null;
  };
  const decorateWithUnownedTerminal = async (
    baseReason: string,
  ): Promise<string> => {
    const unowned = await darwinUnownedTerminalReason();
    return unowned === null
      ? baseReason
      : `${baseReason}; last observed host terminal marker: ${unowned}`;
  };

  while (true) {
    const now = Date.now();
    if (now >= hardDeadline) {
      // Generic timeout. On darwin, decorate with the newest UNOWNED terminal
      // marker (if any) so a legacy-label crash that never earned a fail-fast is
      // still surfaced as a diagnostic hint instead of being silently lost. Owned
      // markers are excluded: a live-but-slow generation timing out here must not
      // be misattributed to a superseded generation's crash (Finding F review).
      const reason =
        darwin === null
          ? lastReason
          : await decorateWithUnownedTerminal(lastReason);
      return { ready: false, version: null, pid: null, reason };
    }
    if (now >= baseDeadline && !extended) {
      if (options.spawnEvidenceBaseline !== null) {
        const evidence = await inspectPostBaselineSpawnEvidence(
          options.spawnEvidenceBaseline,
          markerReader,
        );
        if (evidence.kind === "terminal") {
          return {
            ready: false,
            version: null,
            pid: null,
            reason: evidence.reason,
          };
        }
        if (evidence.kind === "none") {
          return { ready: false, version: null, pid: null, reason: lastReason };
        }
        // Post-baseline spawn evidence (starting marker or fresh pid
        // metadata): keep polling up to the extended hard cap.
        extended = true;
        lastReason = `${lastReason}; extending wait on ${evidence.reason}`;
      } else if (darwin !== null) {
        // Darwin: extend ONLY on a live agent-label pid. If the pid is null but
        // not yet CONFIRMED gone (a transient launchctl miss or the brief
        // crash→relaunch gap), don't decide yet - fall through, keep polling,
        // and re-probe next iteration (this branch re-runs while `!extended`).
        // Once confirmed gone, fail with an owned terminal marker's reason if
        // one exists, else the generic timeout decorated with any unowned marker
        // (the caller adds login-item status).
        const agentPid = await probeDarwinAgentPid(now);
        if (agentPid !== null) {
          extended = true;
          lastReason = `${lastReason}; extending wait on live agent-label pid ${agentPid}`;
        } else if (agentGenerationDeadPastRelaunchGrace(now)) {
          const ownedReason = await darwinOwnedTerminalReason();
          return {
            ready: false,
            version: null,
            pid: null,
            reason:
              ownedReason ?? (await decorateWithUnownedTerminal(lastReason)),
          };
        }
      } else {
        return { ready: false, version: null, pid: null, reason: lastReason };
      }
    }

    const snapshot = await readPidMetadataForReady(pidPath);
    if (snapshot === null) {
      lastReason = "pid metadata not yet published";
    } else if (skipPid !== null && snapshot.pid === skipPid) {
      lastReason = `old host pid ${skipPid} still bound; waiting for replacement`;
    } else if (!isCurrentHostWebsocketUrl(snapshot.websocketUrl)) {
      lastReason = `websocket URL ${snapshot.websocketUrl} does not match the committed host WS shape`;
    } else if (!(await canReachHostWebsocketUrl(snapshot.websocketUrl))) {
      lastReason = `websocket URL ${snapshot.websocketUrl} is not yet reachable`;
    } else {
      return {
        ready: true,
        version: snapshot.version,
        pid: snapshot.pid,
        reason: "ready",
      };
    }

    // Fail-fast on a post-baseline terminal marker even before base
    // budget expires: the host already died for a known reason.
    if (options.spawnEvidenceBaseline !== null) {
      const evidence = await inspectPostBaselineSpawnEvidence(
        options.spawnEvidenceBaseline,
        markerReader,
      );
      if (evidence.kind === "terminal") {
        return {
          ready: false,
          version: null,
          pid: null,
          reason: evidence.reason,
        };
      }
    }

    // Darwin: accumulate observed agent pids + the live/gone signal, then decide
    // fail-fast. While launchctl still yields a live agent pid, NO terminal
    // marker fails the attempt - the live pid is the sole authority, so a
    // superseded generation's marker (or a throttle-cached pid that happens to
    // match an older marker) can never fail a live, recovering attempt
    // (Finding F). Only once the generation is CONFIRMED GONE - no live pid
    // across consecutive probes, not a single transient miss - does an owned
    // terminal marker become the precise death reason, or a lost extension an
    // extension death.
    if (darwin !== null) {
      await probeDarwinAgentPid(now);
      if (agentGenerationDeadPastRelaunchGrace(now)) {
        const ownedReason = await darwinOwnedTerminalReason();
        if (ownedReason !== null) {
          return {
            ready: false,
            version: null,
            pid: null,
            reason: ownedReason,
          };
        }
        if (extended) {
          return {
            ready: false,
            version: null,
            pid: null,
            reason: `${lastReason}; agent-label pid exited during the extended wait`,
          };
        }
      }
    }

    await sleep(pollIntervalMs);
  }
}

type PostBaselineEvidence =
  | { readonly kind: "none" }
  | { readonly kind: "spawn"; readonly reason: string }
  | { readonly kind: "terminal"; readonly reason: string };

const TERMINAL_PHASES = new Set([
  "exited",
  "crashed",
  "killed",
  "failed-to-spawn",
]);

async function inspectPostBaselineSpawnEvidence(
  baseline: HostSpawnEvidenceBaseline,
  markerReader: PostBaselineMarkerReader | null,
): Promise<PostBaselineEvidence> {
  const markers = (
    markerReader === null ? [] : await markerReader.read()
  ).filter((entry) => isMarkerInAuthorityWindow(entry, baseline));
  const currentAttempt = findNewestIdentifiedAttempt(markers);
  if (currentAttempt !== null) {
    if (currentAttempt.phase === "terminal") {
      return {
        kind: "terminal",
        reason: terminalMarkerReason(currentAttempt.marker),
      };
    }
    const terminal = markers
      .slice(currentAttempt.index + 1)
      .find(
        (entry) =>
          markerIdentity(entry) === currentAttempt.identity &&
          TERMINAL_PHASES.has(entry.phase),
      );
    if (terminal !== undefined) {
      return { kind: "terminal", reason: terminalMarkerReason(terminal) };
    }
    return { kind: "spawn", reason: "post-baseline starting marker" };
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry === undefined) continue;
    if (TERMINAL_PHASES.has(entry.phase)) {
      return {
        kind: "terminal",
        reason: terminalMarkerReason(entry),
      };
    }
  }
  for (let i = markers.length - 1; i >= 0; i--) {
    const entry = markers[i];
    if (entry !== undefined && entry.phase === "starting") {
      return { kind: "spawn", reason: "post-baseline starting marker" };
    }
  }
  const pidEvidence = await hasPostBaselinePidMetadata(baseline);
  if (pidEvidence) {
    return { kind: "spawn", reason: "post-baseline pid metadata" };
  }
  return { kind: "none" };
}

interface ParsedMarker {
  readonly timestampMs: number | null;
  readonly phase: string;
  readonly fields: Record<string, string>;
}

interface PostBaselineMarkerReader {
  read(): Promise<readonly ParsedMarker[]>;
}

const MARKER_LINE_RE = /^\[([^\]]+)\] phase=(\w[\w-]*)(?:\s+(.*))?$/;

function createPostBaselineMarkerReader(
  baseline: HostSpawnEvidenceBaseline,
): PostBaselineMarkerReader {
  let offset: number | null = null;
  let dev: number | null = null;
  let ino: number | null = null;
  let pending = "";
  let entries: readonly ParsedMarker[] = [];

  return {
    read: async (): Promise<readonly ParsedMarker[]> => {
      let handle: FileHandle;
      try {
        handle = await open(baseline.logPath, "r");
      } catch {
        return entries;
      }
      try {
        const info = await handle.stat();
        const sameFileIdentity =
          offset !== null && dev === info.dev && ino === info.ino;
        const shrankOpenFile =
          sameFileIdentity && offset !== null && info.size < offset;
        const sameOpenFile = sameFileIdentity && !shrankOpenFile;
        const readOffset = shrankOpenFile
          ? 0
          : sameOpenFile && offset !== null
            ? offset
            : offsetForBaseline(baseline, info);
        if (!sameOpenFile) {
          pending = "";
          entries = [];
        }
        dev = info.dev;
        ino = info.ino;
        offset = info.size;
        if (info.size <= readOffset) return entries;
        const length = info.size - readOffset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, readOffset);
        offset = readOffset + bytesRead;
        const text = pending + buffer.subarray(0, bytesRead).toString("utf8");
        const lines = text.split(/\r?\n/);
        pending = lines.pop() ?? "";
        const fresh: ParsedMarker[] = [];
        for (const line of lines) {
          if (line.length === 0) continue;
          const match = MARKER_LINE_RE.exec(line);
          if (match === null) continue;
          fresh.push({
            timestampMs: Date.parse(match[1] ?? ""),
            phase: match[2] ?? "",
            fields: parseMarkerFields(match[3] ?? ""),
          });
        }
        entries = [...entries, ...fresh].slice(-64);
        return entries;
      } finally {
        await handle.close();
      }
    },
  };
}

function isMarkerInAuthorityWindow(
  marker: ParsedMarker,
  baseline: HostSpawnEvidenceBaseline,
): boolean {
  const identity = markerIdentity(marker);
  if (identity === null || baseline.markerAuthoritySinceMs === null)
    return true;
  return (
    marker.timestampMs !== null &&
    marker.timestampMs >= baseline.markerAuthoritySinceMs
  );
}

function markerIdentity(marker: ParsedMarker): string | null {
  const attempt = marker.fields.attempt;
  const supervisorPid = marker.fields.supervisorPid;
  if (
    typeof attempt !== "string" ||
    attempt.length === 0 ||
    typeof supervisorPid !== "string" ||
    supervisorPid.length === 0
  ) {
    return null;
  }
  return `${attempt}:${supervisorPid}`;
}

function findNewestIdentifiedAttempt(markers: readonly ParsedMarker[]): {
  readonly index: number;
  readonly identity: string;
  readonly phase: "starting" | "terminal";
  readonly marker: ParsedMarker;
} | null {
  let newestStarting: {
    readonly index: number;
    readonly identity: string;
    readonly phase: "starting";
    readonly marker: ParsedMarker;
  } | null = null;
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (marker === undefined || marker.phase !== "starting") continue;
    const identity = markerIdentity(marker);
    if (identity !== null) {
      newestStarting = { index, identity, phase: "starting", marker };
      break;
    }
  }
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    if (
      marker === undefined ||
      marker.phase !== "failed-to-spawn" ||
      (newestStarting !== null && index <= newestStarting.index)
    ) {
      continue;
    }
    const identity = markerIdentity(marker);
    if (identity !== null) {
      return { index, identity, phase: "terminal", marker };
    }
  }
  return newestStarting;
}

function parseMarkerFields(rest: string): Record<string, string> {
  // Minimal key=value parser matching the CLI bootstrap-log grammar well
  // enough to recover `error` / `code` / `signal` for fail-fast reasons.
  // Full fidelity lives in traycer-cli's bootstrap-log (separate bundle).
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i] ?? "")) i++;
    if (i >= rest.length) break;
    const eqIdx = rest.indexOf("=", i);
    if (eqIdx === -1) break;
    const key = rest.slice(i, eqIdx);
    let valueStart = eqIdx + 1;
    let value: string;
    if (rest[valueStart] === '"') {
      valueStart++;
      let valueEnd = valueStart;
      let unescaped = "";
      while (valueEnd < rest.length) {
        const ch = rest[valueEnd] ?? "";
        if (ch === '"' && rest[valueEnd + 1] === '"') {
          unescaped += '"';
          valueEnd += 2;
          continue;
        }
        if (ch === '"') break;
        unescaped += ch;
        valueEnd++;
      }
      value = unescaped;
      i = valueEnd + 1;
    } else {
      let valueEnd = valueStart;
      while (valueEnd < rest.length && !/\s/.test(rest[valueEnd] ?? "")) {
        valueEnd++;
      }
      value = rest.slice(valueStart, valueEnd);
      i = valueEnd;
    }
    fields[key] = value;
  }
  return fields;
}

function offsetForBaseline(
  baseline: HostSpawnEvidenceBaseline,
  info: { readonly size: number; readonly dev: number; readonly ino: number },
): number {
  if (!baseline.logExists) return 0;
  if (
    baseline.logDev !== null &&
    baseline.logIno !== null &&
    (info.dev !== baseline.logDev || info.ino !== baseline.logIno)
  ) {
    return 0;
  }
  if (info.size < baseline.logSize) return 0;
  return baseline.logSize;
}

async function hasPostBaselinePidMetadata(
  baseline: HostSpawnEvidenceBaseline,
): Promise<boolean> {
  const info = await statOrNull(baseline.pidPath);
  if (info === null) return false;
  const snapshot = await readPidMetadataForReady(baseline.pidPath);
  if (snapshot === null) return false;
  if (!baseline.pidExists) {
    return true;
  }
  return (
    baseline.pidMtimeMs !== null &&
    info.mtimeMs > baseline.pidMtimeMs &&
    snapshot.pid !== baseline.pid
  );
}

function terminalMarkerReason(marker: ParsedMarker): string {
  const error = marker.fields.error;
  if (typeof error === "string" && error.length > 0) {
    return `host ${marker.phase}: ${error}`;
  }
  const code = marker.fields.code;
  if (typeof code === "string" && code.length > 0) {
    return `host ${marker.phase} (code=${code})`;
  }
  const signal = marker.fields.signal;
  if (typeof signal === "string" && signal.length > 0) {
    return `host ${marker.phase} (signal=${signal})`;
  }
  return `host ${marker.phase}`;
}

async function statOrNull(
  path: string,
): Promise<{ size: number; dev: number; ino: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return {
      size: info.size,
      dev: info.dev,
      ino: info.ino,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

// Distinct from host-lifecycle's `readPidMetadata`: readiness does not
// require `hostId` to be present yet - a freshly spawned host can publish
// its port/version before the full identity record, and we only need
// version/pid/websocketUrl to confirm the WS endpoint is up.
async function readPidMetadataForReady(path: string): Promise<{
  readonly version: string;
  readonly pid: number;
  readonly websocketUrl: string;
} | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.version !== "string" ||
    typeof obj.pid !== "number" ||
    typeof obj.websocketUrl !== "string"
  ) {
    return null;
  }
  return { version: obj.version, pid: obj.pid, websocketUrl: obj.websocketUrl };
}

// Shape of the `traycer host install`/`ensure` terminal payload we
// inspect for a service-registration failure. Mirrors the CLI producers
// (commands/host-install.ts, commands/host-ensure.ts).
export interface HostEnsureResultPayload {
  readonly version?: string;
  readonly running?: boolean;
  readonly registered?: boolean;
  readonly action?: string;
  readonly serviceLifecycle?: {
    readonly priorServiceState?: string;
    readonly stoppedBeforeSwap?: boolean;
    readonly postSwapAction?: string;
    readonly postSwapError?: string | null;
  } | null;
}

export interface ServiceLifecycleSnapshot {
  readonly priorServiceState: string | null;
  readonly postSwapAction: string | null;
  readonly postSwapError: string | null;
}

export function readServiceLifecycle(
  payload: HostEnsureResultPayload | null | undefined,
): ServiceLifecycleSnapshot {
  const lifecycle = payload?.serviceLifecycle ?? null;
  if (lifecycle === null || typeof lifecycle !== "object") {
    return {
      priorServiceState: null,
      postSwapAction: null,
      postSwapError: null,
    };
  }
  const postSwapErrorRaw = lifecycle.postSwapError;
  const postSwapError =
    typeof postSwapErrorRaw === "string" && postSwapErrorRaw.length > 0
      ? postSwapErrorRaw
      : null;
  return {
    priorServiceState:
      typeof lifecycle.priorServiceState === "string"
        ? lifecycle.priorServiceState
        : null,
    postSwapAction:
      typeof lifecycle.postSwapAction === "string"
        ? lifecycle.postSwapAction
        : null,
    postSwapError,
  };
}

/**
 * Read the ensure payload's `running` flag. Returns null when the field is
 * absent/malformed so callers can distinguish "CLI said not running" from
 * "older CLI didn't report the flag".
 */
export function readEnsureRunning(
  payload: HostEnsureResultPayload | null | undefined,
): boolean | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload.running !== "boolean") return null;
  return payload.running;
}

export type HostEnsureErrorKind =
  | "offline"
  | "signature"
  | "host-not-ready"
  | "service-registration"
  | "host-busy"
  | "unknown";

export interface HostEnsureError {
  readonly kind: HostEnsureErrorKind;
  readonly message: string;
  readonly code: string | null;
}

// Map a CLI failure into a stable, renderer-friendly error. The renderer
// surfaces `message` in the host gate's unavailable/Doctor card.
export function categorizeHostCliError(err: unknown): HostEnsureError {
  if (err instanceof TraycerCliError) {
    if (
      err.code === "E_NETWORK" ||
      err.code === "E_OFFLINE" ||
      err.code === "E_DOWNLOAD_FAILED" ||
      err.code === "E_REGISTRY_UNAVAILABLE" ||
      // Older CLI builds used this spelling. Keep it as a compatibility alias
      // while the current CLI contract uses E_REGISTRY_UNAVAILABLE.
      err.code === "E_REGISTRY_UNREACHABLE"
    ) {
      return {
        kind: "offline",
        message:
          "Traycer needs to download the host to finish setting up. Check your network connection and try again.",
        code: err.code,
      };
    }
    if (
      err.code === "E_SIGNATURE_INVALID" ||
      err.code === "E_CHECKSUM_MISMATCH" ||
      err.code === "E_HOST_VERIFY_FAILED"
    ) {
      return {
        kind: "signature",
        message:
          "The downloaded host failed verification (signature, checksum, or size mismatch). This is a security check - please reinstall Traycer or contact support.",
        code: err.code,
      };
    }
    if (err.code === "E_HOST_BUSY") {
      return {
        kind: "host-busy",
        message:
          "The host has work in progress, so it was not restarted. Checking whether this build can keep using it…",
        code: err.code,
      };
    }
    return { kind: "unknown", message: err.message, code: err.code };
  }
  return {
    kind: "unknown",
    message: err instanceof Error ? err.message : String(err),
    code: null,
  };
}
