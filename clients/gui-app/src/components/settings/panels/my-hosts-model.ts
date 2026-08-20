import type {
  HostStatusDTO,
  HostUpdateState,
} from "@traycer/protocol/host/host-status";
import { hasRecentHostCheckIn } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * The DTO's own reading of a host — **evidence, not a vocabulary**.
 *
 * This is step 3 of `deriveHostHealth`'s precedence and nothing renders it
 * directly. That distinction is the whole point of the redesign's
 * single-vocabulary rule (connection registry §1, quoted at
 * `hooks/host/use-host-lease.ts`): a person reads ONE set of status words,
 * and those words come from `HostHealth`. What lives here is one of the
 * inputs that produces them, which is why its type is named for the source
 * (`DtoPresenceReading`) rather than for a tone something might paint.
 *
 * It used to be a second vocabulary in fact as well as in shape — a
 * `HostPresenceTone` rendered beside a `HostHealthState` derived from it —
 * and P3.4's vocabulary census recorded the pair as the unfinished half of
 * its sweep. The pair is gone: the only caller is `deriveHostHealth`, and the
 * only escape hatch (`formatHostMeta`) had no production reader left and went
 * with it.
 *
 * ONE cloud signal decides reachability: `status.connectivity`. It used to
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
 *      the local service snapshot first. A direct read of the process on this
 *      box beats anything any other layer can say about it.
 *   2. **The LEASE** — also not decided here, and also above this function.
 *      The selection authority aggregates every window's transport evidence
 *      into one verdict per host; when it has spoken, it is the answer.
 *   3. **Live-session evidence** (R4-B5) — decided here, and it survives the
 *      lease's arrival above it rather than being replaced by it. This
 *      function is only reached when the authority has NOT spoken, and in
 *      that window a client holding an open E2E session still has firsthand
 *      proof the host is up, which outranks a cloud lease refreshed on a
 *      slower clock.
 *   4. **`connectivity`** — the cloud's answer, and the ONLY thing known
 *      about a host this client has never dialled. Which is precisely why it
 *      no longer says "Online"; see `reported-reachable` below.
 *
 * That last step takes TWO inputs because the wire carries only one of them.
 * `connectivity` is pure liveness (`connectable` / `offline` / `unknown`) —
 * one fact about one host — while whether the account may reach a host
 * remotely at all is an account fact (`planAllowsRemote`). This row is
 * projected from the RAW registry DTO rather than from a directory entry, so
 * it combines them here; `hostUnavailability` does the identical combination
 * for entries, and the two must agree cell for cell.
 *
 * Three invariants the tests pin:
 *
 *   - NO green dot without live evidence. This one was WRITTEN here and
 *     violated here — see the `connectable` arm.
 *   - NEVER a false "Offline" when the cloud is blind. `unknown` is its own
 *     rendering, and "Local only" is not an outage at all.
 *   - For a plan-gated host, relay `offline` is expected even while healthy:
 *     the attach-grant gate suppresses the host leg. A recent plan-agnostic
 *     credential check-in therefore reads "Local only"; stale or missing
 *     check-in evidence reads Offline.
 */

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
  /**
   * Whether the ACCOUNT's plan includes remote hosts. The second axis
   * `status.connectivity` deliberately no longer carries; unknown reads as
   * `true` (allowed) at the source, never as a restriction.
   */
  readonly planAllowsRemote: boolean;
  /** Explicit clock for the credential-check-in freshness decision. */
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
    // `connectable` or `unknown`, the answer is the same: this host will not be
    // reached from here, because the account's plan has no remote hosts. Not an
    // outage — rendering it "Offline" would put a fault where there is none and
    // imply a retry as the fix. Nothing about the machine is claimed either
    // way, which is exactly what makes this safe under a blind liveness read.
    return { reading: "local-only", label: "Local only", showLiveDot: false };
  }
  switch (status.connectivity) {
    // The host's own leg is up - AS OF THE LAST LEASE REFRESH, which is the
    // entire content of the claim and, until F26, not what it said.
    //
    // This arm returned `Online` with `showLiveDot: true`, and the dot is the
    // part that mattered: the lease TTL is 15 minutes, so a host that died
    // dirty kept a green "Online" for up to a quarter of an hour with nothing
    // client-side narrowing it, and the 60s keep-warm linger extended even
    // that. Nothing here has dialled the machine - by the time this arm is
    // reached the local read said nothing, the authority has published no
    // lease, and the live-session override above declined - so the strongest
    // honest sentence is that the ACCOUNT heard from it, not that it is up.
    //
    // The green dot was also a straight violation of this file's own stated
    // invariant, four paragraphs up: "NO green dot without live evidence:
    // `showLiveDot` is `true` only for a live session or a `connectable`
    // lease." The second clause is what made the rule vacuous - it named the
    // stale lease as live evidence, which is the thing it was written to
    // exclude. The clause is gone and the dot with it; a live session still
    // lights it, from the arm above, where the evidence actually is.
    //
    // There was a second arm here - "reachable, but THIS viewer's path to it
    // is failing" - keyed on a per-viewer probe that was never built (F9): the
    // store behind it had a getter and no writer, so the arm was unreachable
    // code and the pill it drew had never once rendered. Deleted with that
    // machinery in P3.4; if a real viewer-path probe is ever built, it comes
    // back with a producer this time.
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

// `formatHostMeta` lived here and is gone. It built the identity meta line
// under a host name ("Ubuntu · v1.4.2", falling back to a last-seen hint) for
// the My Hosts row, and that row was replaced by `HostIdentityCard` — which
// assembles the same facts itself from `platform`/`arch`/`version` and reads
// the last-seen out of `health.detail`. Nothing has called this since; the
// census at deletion found 7 references repo-wide, ONE of them the definition
// and the other six inside its own test file.
//
// It is deleted rather than left because of what it was: the last consumer of
// `DtoPresenceView` outside `deriveHostHealth`, i.e. the one remaining way for
// the DTO reading to reach a surface as its own vocabulary. Keeping a dead
// function whose parameter type is the thing this pass exists to demote would
// have left the retirement true only by accident.
