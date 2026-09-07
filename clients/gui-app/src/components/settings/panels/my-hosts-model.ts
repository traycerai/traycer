import type {
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import { readHostRuntimeStatusAwareness } from "@traycer/protocol/host/notifications/index";
import type { HostBusyBreakdown } from "@traycer/protocol/host/status/index";
import { hasRecentHostCheckIn } from "@traycer-clients/shared/host-client/remote-fetcher";
import { busyWorkPhrase } from "@/components/host/host-restart-copy";

/** This row is projected from the raw registry DTO rather than from a directory entry, so it combines them
 * here; `hostUnavailability` does the identical combination for entries, and the two must agree cell for cell. */

export type DtoPresenceReading =
  | "online"
  | "reported-reachable"
  | "local-only"
  | "offline"
  | "unknown"
  | "client-offline";

export interface DtoPresenceView {
  readonly reading: DtoPresenceReading;
  readonly label: string;
  /** A green liveness dot renders ONLY when a live session backs it. */
  readonly showLiveDot: boolean;
}

export interface DeriveHostPresenceOptions {
  readonly status: HostStatusDTO;
  readonly hasLiveSession: boolean;
  /** The second axis `status.connectivity` deliberately no longer carries; unknown reads as `true` (allowed) at
   * the source, never as a restriction. */
  readonly planAllowsRemote: boolean;
  readonly nowMs: number;
}

export function deriveHostPresence(
  options: DeriveHostPresenceOptions,
): DtoPresenceView {
  const { status, hasLiveSession, planAllowsRemote, nowMs } = options;
  // This client is offline: we cannot claim anything about the host's liveness.
  if (status.clientCloud === "down") {
    return {
      reading: "client-offline",
      label: "You're offline",
      showLiveDot: false,
    };
  }
  // Live-session-evidence override (R4-B5): a client holding an open E2E
  // session to this host renders Online regardless of everything below.
  if (hasLiveSession) {
    return { reading: "online", label: "Online", showLiveDot: true };
  }
  if (status.connectivity === "local-only") {
    // Transitional value from a pre-cutover server. It carries the plan fact
    // but no liveness evidence, so never turn it into a death claim.
    return { reading: "local-only", label: "Local only", showLiveDot: false };
  }
  if (status.connectivity === "offline") {
    if (!planAllowsRemote && hasRecentHostCheckIn(status, nowMs)) {
      return {
        reading: "local-only",
        label: "Local only",
        showLiveDot: false,
      };
    }
    return { reading: "offline", label: "Offline", showLiveDot: false };
  }
  if (!planAllowsRemote) {
    // Nothing about the machine is claimed either way, which is exactly what makes this safe under a blind
    // liveness read.
    return { reading: "local-only", label: "Local only", showLiveDot: false };
  }
  switch (status.connectivity) {
    // The host's own leg is up - AS OF the last lease refresh, which is the entire content of the claim and,
    // until, not what it said.
    case "connectable":
      return {
        reading: "reported-reachable",
        label: "Reported reachable",
        showLiveDot: false,
      };
    case "unknown":
      // The cloud could not read liveness. Blind is not the same as absent.
      return {
        reading: "unknown",
        label: "Status unknown",
        showLiveDot: false,
      };
  }
}

export type HostUpdatePillTone = "info" | "warn" | "danger";

export interface HostUpdatePill {
  readonly label: string;
  readonly tone: HostUpdatePillTone;
}

/** Maps the update lifecycle to a pill (Architecture §7/§13). */
export function deriveUpdatePill(
  updateState: HostUpdateState,
): HostUpdatePill | null {
  switch (updateState) {
    case "available":
      return { label: "Update available", tone: "warn" };
    case "pending":
      return { label: "Update pending", tone: "warn" };
    case "updating":
      return { label: "Updating…", tone: "info" };
    case "failed":
      return { label: "Update failed", tone: "danger" };
    case "required":
      return { label: "Update required", tone: "danger" };
    case "current":
      return null;
  }
}

// Update affordances (Architecture §13, T16): "Update now" version input, auto-policy toggle, and the "Apply
// now - ends N sessions" drain-gate force.

// Both existed only because that control let someone name a version nothing had confirmed.

export interface HostUpdateAffordanceView {
  /** "Waiting for N sessions" / "Waiting for 2 agents and 1 terminal". */
  readonly waitingForSessionsLabel: string | null;
  /** Whether to show the "Apply now" drain-gate force. */
  readonly showApplyNowForce: boolean;
  /** "Apply now - ends 2 agents and 1 terminal" when a breakdown is present, "Apply now - ends N sessions" for a
   * @1.1 host, or `null` when the force isn't offered. */
  readonly applyNowLabel: string | null;
}

export interface LiveBusySessionCountOptions {
  readonly reportedCount: number | null;
  /** The read failed. TanStack keeps serving the last success regardless. */
  readonly isError: boolean;
  readonly fetchStatus: "fetching" | "paused" | "idle";
  /** When the scope loses its route the query is disabled rather than failed: TanStack retains the last success
   * as idle, non-error and - until `staleTime`. */
  readonly hasLiveSource: boolean;
  /** This is the age check, expressed in TanStack's own terms rather than as wall-clock arithmetic - which is why
   * the query's `staleTime` is set longer than its poll interval. */
  readonly isStale: boolean;
}

/** `host.status` has no subscription, so a panel can sit open, lose the host, and keep rendering the count it
 * saw minutes ago. */
function isUsableBusySource(options: LiveBusySessionCountOptions): boolean {
  if (!options.hasLiveSource) {
    return false;
  }
  // Replacement in flight: keep the last answer, even if the previous attempt errored. Error must not blank the
  // chip for the length of a round trip - that is what `settledBusySessionCount` refuses to arm from.
  if (options.fetchStatus === "fetching") {
    return true;
  }
  if (options.isError || options.fetchStatus === "paused") {
    return false;
  }
  if (options.isStale) {
    return false;
  }
  return true;
}

export function liveBusySessionCount(
  options: LiveBusySessionCountOptions,
): number | null {
  if (!isUsableBusySource(options)) {
    return null;
  }
  return options.reportedCount;
}

export interface LiveBusyBreakdownOptions extends LiveBusySessionCountOptions {
  readonly reportedBreakdown: HostBusyBreakdown | null;
}

export function liveBusyBreakdown(
  options: LiveBusyBreakdownOptions,
): HostBusyBreakdown | null {
  if (!isUsableBusySource(options)) {
    return null;
  }
  return options.reportedBreakdown;
}

export function settledBusyBreakdown(
  options: LiveBusyBreakdownOptions,
): HostBusyBreakdown | null {
  if (options.fetchStatus !== "idle" || options.isStale) {
    return null;
  }
  return liveBusyBreakdown(options);
}

export interface LiveHostBusyOptions extends LiveBusySessionCountOptions {
  readonly reportedBusy: boolean;
}

export function liveHostBusy(options: LiveHostBusyOptions): boolean {
  if (!isUsableBusySource(options)) {
    return false;
  }
  return options.reportedBusy;
}

export function settledHostBusy(options: LiveHostBusyOptions): boolean {
  if (options.fetchStatus !== "idle" || options.isStale) {
    return false;
  }
  return liveHostBusy(options);
}

/** The typed split from a room `hostRuntimeStatus` awareness entry, or `null` when the entry is absent,
 * malformed, or an older host that omitted the key. Absence is not a zero object. */
export function busyBreakdownFromAwareness(
  entry: unknown,
): HostBusyBreakdown | null {
  const status = readHostRuntimeStatusAwareness(entry);
  if (status === null) return null;
  return status.busyBreakdown ?? null;
}

/** The guard cannot catch it - it is comparing a value to itself. */
export function settledBusySessionCount(
  options: LiveBusySessionCountOptions,
): number | null {
  if (options.fetchStatus !== "idle" || options.isStale) {
    return null;
  }
  return liveBusySessionCount(options);
}

export interface DeriveUpdateAffordanceOptions {
  readonly updateState: HostUpdateState;
  /** Open work blocking the drain, from a live source only - `host.status@1.2` over an open connection, or the
   * room's `hostRuntimeStatus` awareness entry. */
  readonly liveBusySessionCount: number | null;
  /** Never a fabricated zero object. */
  readonly liveBusyBreakdown: HostBusyBreakdown | null;
}

function pluralizeSessions(count: number): string {
  return count === 1 ? "session" : "sessions";
}

/** The numbers therefore have to come from a live read of the host, and `null` - no live source - must render
 * nothing rather than a zero. */
export function deriveUpdateAffordance(
  options: DeriveUpdateAffordanceOptions,
): HostUpdateAffordanceView {
  const { updateState, liveBusySessionCount, liveBusyBreakdown } = options;
  const noDrainAffordance = {
    waitingForSessionsLabel: null,
    showApplyNowForce: false,
    applyNowLabel: null,
  } as const;
  // `null` is NOT zero: no live source means nothing to state, so the notice
  // and the force both withhold rather than naming a count nobody read.
  if (updateState !== "pending" || liveBusySessionCount === null) {
    return noDrainAffordance;
  }
  if (liveBusySessionCount === 0) return noDrainAffordance;
  const named =
    liveBusyBreakdown === null ? null : busyWorkPhrase(liveBusyBreakdown);
  if (named !== null) {
    return {
      waitingForSessionsLabel: `Waiting for ${named}`,
      showApplyNowForce: true,
      applyNowLabel: `Apply now — ends ${named}`,
    };
  }
  const sessionsWord = pluralizeSessions(liveBusySessionCount);
  return {
    waitingForSessionsLabel: `Waiting for ${liveBusySessionCount} ${sessionsWord}`,
    showApplyNowForce: true,
    applyNowLabel: `Apply now — ends ${liveBusySessionCount} ${sessionsWord}`,
  };
}

/** Human relative last-seen ("last seen 2h ago"), from the durable registry timestamp (survives cache loss).
 * Returns `null` when never seen or unparsable. */
export function formatLastSeen(
  lastSeenAt: string | null,
  nowMs: number,
): string | null {
  if (lastSeenAt === null) {
    return null;
  }
  const then = Date.parse(lastSeenAt);
  if (Number.isNaN(then)) {
    return null;
  }
  const deltaSeconds = Math.max(0, Math.round((nowMs - then) / 1000));
  return `last seen ${formatElapsed(deltaSeconds)}`;
}

function formatElapsed(deltaSeconds: number): string {
  if (deltaSeconds < 45) {
    return "just now";
  }
  const minutes = Math.round(deltaSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Keeping a dead function whose parameter type is the thing this pass exists to demote would have left the
// retirement true only by accident.
