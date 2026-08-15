import type {
  HostListItem,
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";

/**
 * Pure status derivation for a host row. Every row is a pure function of the
 * host-status DTO plus two client-local signals (live-session evidence, the
 * viewer's own last reachability check) — no ambient probing beyond what those
 * two already recorded elsewhere.
 *
 * ONE cloud signal now decides reachability: `status.connectivity`. It used to
 * take two — a heartbeat lease and a separately-derived relay-attach bit — and
 * the extra states this file used to carry (`tunnel-down`, `likely-reachable`)
 * existed only to narrate the cases where those two disagreed. "Up,
 * re-establishing its tunnel" and "Not reporting — likely reachable" were
 * therefore statements about our own bookkeeping dressed as statements about
 * the machine, and neither told a person anything they could act on. They are
 * gone, along with the lease tri-state that produced them.
 *
 * Precedence, and each step's claim to outrank the next:
 *
 *   1. **The local process read** — not decided here. `deriveHostHealth` asks
 *      the local service snapshot first and only reaches this function when
 *      there is no such answer. A direct read of the process on this box beats
 *      anything the cloud can say about it.
 *   2. **Live-session evidence** (R4-B5) — a client holding an open E2E session
 *      to the host has firsthand proof it is up. That outranks `connectivity`,
 *      which is a lease the cloud refreshes on a slower clock.
 *   3. **`connectivity`** — the cloud's answer, and the only one for a host
 *      this client has never dialled.
 *
 * Two invariants the tests pin:
 *
 *   - NO green dot without live evidence: `showLiveDot` is `true` only for a
 *     live session or a `connectable` lease.
 *   - NEVER a false "Offline" when the cloud is blind. `unknown` is its own
 *     rendering, and `local-only` is not an outage at all.
 */

export type HostPresenceTone =
  | "online"
  | "connection-issue"
  | "local-only"
  | "offline"
  | "unknown"
  | "client-offline";

export interface HostPresenceView {
  readonly tone: HostPresenceTone;
  readonly label: string;
  /** A green liveness dot renders ONLY when a live session/lease backs it. */
  readonly showLiveDot: boolean;
}

export interface DeriveHostPresenceOptions {
  readonly status: HostStatusDTO;
  readonly isViewerLocalHost: boolean;
  readonly hasLiveSession: boolean;
  readonly viewerCheck: ViewerReachabilityCheckLike | null;
  readonly nowMs: number;
}

export function deriveHostPresence(
  options: DeriveHostPresenceOptions,
): HostPresenceView {
  const { status, isViewerLocalHost, hasLiveSession, viewerCheck, nowMs } =
    options;
  // This client is offline: we cannot claim anything about the host's liveness.
  if (status.clientCloud === "down") {
    return {
      tone: "client-offline",
      label: "You're offline",
      showLiveDot: false,
    };
  }
  // Live-session-evidence override (R4-B5): a client holding an open E2E
  // session to this host renders Online regardless of everything below.
  if (hasLiveSession) {
    return { tone: "online", label: "Online", showLiveDot: true };
  }
  switch (status.connectivity) {
    case "connectable": {
      // The host's leg is up and this client's own probe says the path to it is
      // not. Only a REMOTE row can be in this state — a local host is not
      // reached over a relay — and the distinction is worth keeping because the
      // remedy differs: this is the viewer's network, not the host's.
      if (
        !isViewerLocalHost &&
        viewerCheck !== null &&
        viewerCheck.result === "failing"
      ) {
        return {
          tone: "connection-issue",
          label: `Reachable, connection issue (checked ${formatElapsed(
            Math.max(0, Math.round((nowMs - viewerCheck.checkedAtMs) / 1000)),
          )})`,
          showLiveDot: true,
        };
      }
      return { tone: "online", label: "Online", showLiveDot: true };
    }
    case "local-only":
      // Not an outage: this host never attaches to a relay because the plan
      // does not include remote hosts. Rendering it "Offline" would put a
      // fault where there is none and imply a retry as the fix.
      return { tone: "local-only", label: "Local only", showLiveDot: false };
    case "unknown":
      // The cloud could not read liveness. Blind is not the same as absent.
      return { tone: "unknown", label: "Status unknown", showLiveDot: false };
    case "offline":
      return { tone: "offline", label: "Offline", showLiveDot: false };
  }
}

/** Structural subset of `ViewerReachabilityCheck` so this module stays UI-free. */
export interface ViewerReachabilityCheckLike {
  readonly result: "ok" | "failing";
  readonly checkedAtMs: number;
}

export type HostUpdatePillTone = "info" | "warn" | "danger";

export interface HostUpdatePill {
  readonly label: string;
  readonly tone: HostUpdatePillTone;
}

/**
 * Maps the update lifecycle to a pill (Architecture §7/§13). `current` shows
 * nothing. S1 populates `current`/`pending`/`required`; the remaining states
 * are rendered for completeness once the S3 reconciler emits them.
 */
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

// -----------------------------------------------------------------------------
// Update affordances (Architecture §13, T16): "Update now" version input,
// auto-policy toggle, and the "Apply now — ends N sessions" drain-gate force.
// -----------------------------------------------------------------------------

// `isValidHostVersion` and `showUpdateNowInput` lived here and are gone with the
// free-text "Update to version…" pin they served.
//
// Both existed only because that control let someone name a version nothing had
// confirmed: the regex mirrored authn-v3's server-side check so a typo failed
// here instead of as a 400, and the flag hid the input while a `desiredVersion`
// write was already draining toward the host, so a second one could not
// retarget an update mid-flight. The Overview now lists the versions the host
// itself reports and installs the one that was clicked, which makes the first
// unnecessary and moves the second into `HostVersionRows` — where an install in
// flight freezes every row, not just the one it belongs to.

export interface HostUpdateAffordanceView {
  /**
   * "Waiting for N sessions" — populated only when the host is actually
   * gated on open sessions (`updateState === "pending"` AND a LIVE session
   * count above zero); `null` otherwise, including a `pending` host that
   * hasn't started draining and a host with no live source at all.
   */
  readonly waitingForSessionsLabel: string | null;
  /** Whether to show the "Apply now — ends N sessions" drain-gate force. */
  readonly showApplyNowForce: boolean;
  /** "Apply now — ends N sessions", or `null` when the force isn't offered. */
  readonly applyNowLabel: string | null;
}

export interface LiveBusySessionCountOptions {
  /** `host.status`'s count, or `null` when the peer did not report one. */
  readonly reportedCount: number | null;
  /** The read failed. TanStack keeps serving the last success regardless. */
  readonly isError: boolean;
  /** TanStack's fetch state; `paused` means offline and unable to refresh. */
  readonly fetchStatus: "fetching" | "paused" | "idle";
  /**
   * The live RPC behind the read is currently enabled and mounted. When the
   * scope loses its route the query is DISABLED rather than failed: TanStack
   * retains the last success as idle, non-error and - until `staleTime` -
   * non-stale, so the fields above would classify a SOURCELESS number as
   * settled for up to that window. The count's own contract is "from a LIVE
   * source only, `null` means no live source"; a disabled query is not one,
   * so `false` demotes both counts immediately instead of after the age-out.
   */
  readonly hasLiveSource: boolean;
  /**
   * The cached value has aged past its `staleTime`.
   *
   * This is the AGE check, expressed in TanStack's own terms rather than as
   * wall-clock arithmetic — which is why the query's `staleTime` is set LONGER
   * than its poll interval. A healthy poll refreshes well before the window
   * expires, so `isStale` stays false; if the interval stops firing or every
   * refetch fails, the data ages out and this flips. Reading a clock here
   * instead would be an impure call during render AND would need its own
   * ticker to notice the passage of time.
   */
  readonly isStale: boolean;
}

/**
 * The drain count to SHOW, when it is a plausibly live reading.
 *
 * TanStack retains the last successful `data` after a refetch error, which is
 * the right default for almost everything and exactly wrong here. `host.status`
 * has no subscription, so a panel can sit open, lose the host, and keep
 * rendering the count it saw minutes ago — the same stale-count failure the
 * move off the cloud DTO was meant to end, reintroduced by the cache instead of
 * by the wire. The failure is concrete: the page promises "ends 2 sessions"
 * while five are open, and the force ends five.
 *
 * So three things demote a retained value to `null` — no live source:
 *
 *   - the last read ERRORED (retained ≠ current);
 *   - fetching is PAUSED (offline; nothing will correct it);
 *   - the value has gone STALE with nothing in flight to correct it.
 *
 * The staleness check is the one that catches the quiet case, where nothing
 * failed loudly and the data simply stopped being refreshed.
 *
 * Stale WHILE a replacement is in flight keeps rendering the retained number,
 * and that is a display decision only. It is not a claim the number is current —
 * "the fresh answer is in flight" does not make the old one fresh — it is a
 * choice not to blank a panel for the length of a round trip. Nothing
 * destructive may be armed from it; see {@link settledBusySessionCount}, which
 * is what the force reads.
 */
export function liveBusySessionCount(
  options: LiveBusySessionCountOptions,
): number | null {
  if (!options.hasLiveSource) {
    return null;
  }
  if (options.isError || options.fetchStatus === "paused") {
    return null;
  }
  if (options.isStale && options.fetchStatus !== "fetching") {
    return null;
  }
  return options.reportedCount;
}

/**
 * The drain count a DESTRUCTIVE action may stand behind: the same read, settled.
 *
 * The split exists because one number was doing two jobs with opposite failure
 * costs. Showing a slightly-behind count while its replacement is in flight
 * costs a moment of imprecision on a label. ARMING a force from that same count
 * costs sessions: the panel shows 2, a focus refetch begins while the host is
 * actually at 5, the person arms and confirms inside the round trip, and the
 * confirm-time equality guard compares the retained 2 against the armed 2,
 * agrees with itself, and ends all five while promising two. The guard cannot
 * catch it — it is comparing a value to itself.
 *
 * So this one additionally requires the read to be SETTLED: nothing in flight
 * (`fetchStatus === "idle"`) and not aged out (`!isStale`). Anything else is a
 * value we cannot currently stand behind, and the destructive path treats
 * "cannot stand behind" the way it already treats a lost source — it refuses.
 *
 * The cost is that arming is unavailable for the duration of each poll's round
 * trip. That is a host RPC over an already-open connection, and refusing for
 * that window is much cheaper than being wrong once.
 */
export function settledBusySessionCount(
  options: LiveBusySessionCountOptions,
): number | null {
  if (options.fetchStatus !== "idle" || options.isStale) {
    return null;
  }
  return liveBusySessionCount(options);
}

export interface DeriveUpdateAffordanceOptions {
  /** Registry-backed, and available for an offline host. */
  readonly updateState: HostUpdateState;
  /**
   * Open sessions blocking the drain, from a LIVE source only —
   * `host.status@1.1` over an open connection, or the room's
   * `hostRuntimeStatus` awareness entry. `null` means no live source, which is
   * NOT zero: see the drain rules below.
   */
  readonly liveBusySessionCount: number | null;
}

function pluralizeSessions(count: number): string {
  return count === 1 ? "session" : "sessions";
}

/**
 * Derives the update affordances (Architecture §13) from two sources with
 * deliberately different reliability, and the split is the whole point.
 *
 * The registry-backed half of this — the free-text "Update to version…" pin and
 * the `showUpdateNowInput` flag that hid it mid-drain — is gone; see the note
 * above `HostUpdateAffordanceView`. What is left is drain state only.
 *
 * The drain affordances are not registry-backed. "Waiting for N sessions" and,
 * far more
 * seriously, "Apply now — ends N sessions" both NAME A COUNT and, in the second
 * case, destroy that many sessions on click. The count therefore has to come
 * from a live read of the host, and `null` — no live source — must render
 * NOTHING rather than a zero:
 *
 *   - `null` treated as 0 would silently withdraw the drain-gate notice from a
 *     host that is genuinely waiting on sessions, making a `pending` update
 *     look stalled for no stated reason;
 *   - and if the force button were shown anyway, it would offer to end "0
 *     sessions" while ending however many are actually open.
 *
 * These fields used to ride the cloud hosts DTO, where the number could be up
 * to a lease-interval stale. They now come from `host.status@1.1` / room
 * awareness precisely so the count on the button is the count that dies.
 */
export function deriveUpdateAffordance(
  options: DeriveUpdateAffordanceOptions,
): HostUpdateAffordanceView {
  const { updateState, liveBusySessionCount } = options;
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
  const sessionsWord = pluralizeSessions(liveBusySessionCount);
  return {
    waitingForSessionsLabel: `Waiting for ${liveBusySessionCount} ${sessionsWord}`,
    showApplyNowForce: true,
    applyNowLabel: `Apply now — ends ${liveBusySessionCount} ${sessionsWord}`,
  };
}

/**
 * Human relative last-seen ("last seen 2h ago"), from the durable registry
 * timestamp (survives cache loss). Returns `null` when never seen or unparsable.
 */
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

/**
 * The identity meta line under a host name. Joins the platform and the
 * last-reported version ("Ubuntu · v1.4.2"), falling back to the last-seen
 * hint for a host with no live version. Returns `null` when nothing is known.
 */
export function formatHostMeta(
  item: HostListItem,
  presence: HostPresenceView,
  nowMs: number,
): string | null {
  const parts: string[] = [];
  if (item.platform !== null && item.platform.length > 0) {
    parts.push(item.platform);
  }
  if (item.status.appVersion !== null && item.status.appVersion.length > 0) {
    parts.push(`v${item.status.appVersion}`);
  }
  // For a host we cannot vouch for, the durable last-seen is the more useful
  // hint than a stale version string. `unknown` qualifies for the same reason
  // `offline` does — arguably more so, since a blind liveness read leaves
  // `lastSeenAt` as the only thing on the row that is still known to be true.
  // `local-only` does NOT: nothing there is stale or missing, so replacing the
  // identity line with a last-seen would read as a fault.
  if (presence.tone === "offline" || presence.tone === "unknown") {
    const lastSeen = formatLastSeen(item.status.lastSeenAt, nowMs);
    if (lastSeen !== null) {
      return lastSeen;
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" · ");
}
