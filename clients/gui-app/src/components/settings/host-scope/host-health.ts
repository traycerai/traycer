import type { HostListItem } from "@traycer/protocol/host/host-status";
import type { ServiceStatusSnapshot } from "@traycer-clients/shared/platform/runner-host";
import type {
  HostLeaseDeadState,
  HostLeaseSnapshot,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import {
  deriveHostPresence,
  formatLastSeen,
} from "@/components/settings/panels/my-hosts-model";

/**
 * ONE health vocabulary for every host, everywhere.
 *
 * Before this, a host could be described by two disjoint vocabularies that
 * never met: the registry-backed presence words ("Online", "Status unknown",
 * "Offline") and the local service words ("Running", "Stopped", "Not
 * installed"). The SAME machine — your own — was rendered with both, in two
 * different cards, and a reader had no way to know they described one thing.
 * That is the defect this type closed.
 *
 * It closed it one layer short, though, and this pass is the rest. The words
 * were unified while their EVIDENCE was not: everything below the local
 * service read came from the cloud DTO, so the app carried a status vocabulary
 * that no amount of firsthand knowledge could correct. Meanwhile the selection
 * authority — which aggregates every window's actual transport outcomes into
 * one verdict per host — was published, consumed by tiles, and invisible here.
 * `hooks/host/use-host-lease.ts` has stated the rule since P3.3: *all status UI
 * derives from the lease vocabulary; no surface reads sockets, probe caches, or
 * the cloud DTO directly.* This file is what makes that sentence true rather
 * than aspirational.
 *
 * The split is by MEANING rather than by data source:
 *
 *   - `state` is the coarse thing a person acts on. They are mutually
 *     exclusive.
 *   - `detail` carries the honest nuance the old design spent a row of pills
 *     on ("last seen 3h ago"). It is a sentence fragment, never a status word
 *     competing with `state`.
 *
 * `stopped` and `not-installed` are THIS-MACHINE-ONLY: only a machine this
 * client can manage can be in them, and both are actionable rather than merely
 * informational — which is exactly why they must not be flattened into
 * "Offline". A remote host that is off simply reads `offline`.
 *
 * `local-only` is a different thing wearing a similar word, and the two must
 * not be conflated. It is not about which machine is doing the reading: it is
 * the account's plan saying this host will never be reachable remotely, which
 * is why it carries an upgrade as its remedy where `stopped` carries a Start
 * button. Any host — including a remote one on someone else's desk — can be
 * `local-only`.
 *
 * Where that state comes from changed, though the state and its copy did not.
 * It used to be a wire value (`connectivity: "local-only"`), which meant the
 * server decided it and liveness was lost behind it. Now the wire carries
 * pure liveness and this reads the ACCOUNT's plan alongside it
 * (`planAllowsRemote`) — so a plan-gated host that is genuinely `offline`
 * reaches `offline` here, with a last-seen detail, instead of being dressed
 * as a billing state forever.
 *
 * `reported-reachable` is the state that exists because the honest answer for
 * a never-dialled host is neither "Online" nor "Offline" (F26). See
 * `deriveHostPresence`.
 */
export type HostHealthState =
  | "online"
  | "reported-reachable"
  | "restarting"
  | "local-only"
  | "unknown"
  | "offline"
  | "update-required"
  | "removed"
  | "stopped"
  | "not-installed"
  | "viewer-offline";

export type HostHealthTone = "live" | "warn" | "idle";

export interface HostHealth {
  readonly state: HostHealthState;
  /** Short status word. Never repeats `detail`. */
  readonly label: string;
  /** The nuance — a fragment, or `null` when the label already says it all. */
  readonly detail: string | null;
  readonly tone: HostHealthTone;
  /**
   * A live dot renders ONLY when live evidence backs it — a lease this window
   * is actually serving through, an open session, or the process running on
   * this very machine. Never a cloud lease: that clause is what made the same
   * invariant vacuous where it was first written (`deriveHostPresence`).
   */
  readonly live: boolean;
}

export const HOST_HEALTH_TONE: Record<HostHealthState, HostHealthTone> = {
  online: "live",
  // Not a fault and not a claim: nothing has reached this machine from here,
  // so it gets the same muted treatment as a host that is simply not running.
  "reported-reachable": "idle",
  // A restart we asked for or expect is not a failure in progress.
  restarting: "idle",
  // Not a fault, so not a warning: the host is exactly as reachable as the
  // plan says it should be. `idle` keeps it visually alongside a host that is
  // simply not running rather than alongside one that is failing.
  "local-only": "idle",
  unknown: "warn",
  offline: "idle",
  // Actionable, like `stopped`: something a person can fix, and the row offers
  // the fix where it is a fix this app can perform.
  "update-required": "warn",
  // Terminal but not broken — the same "it is simply not here" class as
  // `offline`, and a warning colour would imply a repair that does not exist.
  removed: "idle",
  stopped: "warn",
  "not-installed": "idle",
  "viewer-offline": "idle",
};

export interface DeriveHostHealthOptions {
  /** Registry row, or `null` for a host the registry has not listed. */
  readonly item: HostListItem | null;
  readonly isLocalMachine: boolean;
  readonly hasLiveSession: boolean;
  /**
   * The local service snapshot, for THIS machine only. It outranks every
   * other signal for a local host — a direct read of the process on this box
   * beats both the authority's aggregate and anything the cloud can say. It is
   * also the only source that can distinguish "installed but not running" from
   * "not installed" — a distinction every other layer erases into a single
   * `offline`, and the one that decides whether we can offer Start or must
   * offer Install.
   *
   * This is step 1 of the derivation precedence; `deriveHostHealth`'s own
   * doc-comment carries the rest.
   */
  readonly service: ServiceStatusSnapshot | undefined;
  /**
   * The selection authority's verdict for this host, or `null` when it has
   * published none.
   *
   * `null` is NOT death, and neither is `connecting` — see
   * {@link leaseHealth}. Both mean "no verdict yet", which is a different
   * fact from "the verdict is bad" and must fall through to the weaker
   * evidence below rather than terminate the derivation.
   */
  readonly lease: HostLeaseSnapshot | null;
  /**
   * Whether this window's selection kernel has attached at all.
   *
   * Without it a `null` lease is ambiguous in exactly the way that matters:
   * before the bridge mounts, EVERY host has a null lease, and a derivation
   * that read that as evidence would blank or kill the entire fleet on every
   * cold start.
   */
  readonly authorityAttached: boolean;
  /**
   * Whether the ACCOUNT's plan includes remote hosts — the axis the wire no
   * longer carries, combined with `connectivity` in `deriveHostPresence`. This
   * surface reads the raw registry DTO rather than a directory entry, so the
   * caller supplies it (the negation of `useRemoteHostsPlanRestricted`), where
   * an entry-based surface reads the `planAllowsRemote` stamped at projection
   * time.
   */
  readonly planAllowsRemote: boolean;
  readonly nowMs: number;
}

/**
 * One host's health, from the strongest evidence available.
 *
 * Precedence, and each step's claim to outrank the next:
 *
 *   1. **The local process read** — firsthand, about a process on this box.
 *   2. **The lease** — the selection authority's aggregate of what every
 *      window's transports actually observed. This is the app's own
 *      experience of the host, and it is why a host can read `Offline` here
 *      while the cloud still holds a `connectable` lease for it (the F26
 *      window, now narrowed by real evidence instead of waited out).
 *   3. **The cloud DTO** — the only thing known about a host nothing has
 *      dialled, and deliberately the weakest.
 *
 * Steps 2 and 3 are a FALL-THROUGH, not a switch. The lease step returns
 * `null` for "no verdict yet" so an unattached authority or a host still
 * connecting lands on the DTO answer rather than on a manufactured failure.
 * That direction is the load-bearing one: a fail-closed reading here would
 * render an entire fleet dead for the length of every bootstrap, and — because
 * the same store backs the pickers that let a person do anything about it —
 * would suppress the surfaces that could clear it.
 */
export function deriveHostHealth(options: DeriveHostHealthOptions): HostHealth {
  const local = localServiceHealth(options);
  if (local !== null) return local;
  const lease = leaseHealth(options);
  if (lease !== null) return lease;
  return registryHealth(options);
}

/**
 * The local machine's health, or `null` when this is not the local machine (or
 * its service snapshot has not resolved yet, in which case the weaker answers
 * are still better than nothing).
 */
function localServiceHealth(
  options: DeriveHostHealthOptions,
): HostHealth | null {
  const { isLocalMachine, service } = options;
  if (!isLocalMachine || service === undefined) return null;
  if (service.state === "not-installed") {
    return {
      state: "not-installed",
      label: "Not installed",
      detail: "No Traycer host is installed on this computer yet.",
      tone: HOST_HEALTH_TONE["not-installed"],
      live: false,
    };
  }
  if (service.state === "stopped") {
    return {
      state: "stopped",
      label: "Stopped",
      detail: "Installed, but the host process isn't running.",
      tone: HOST_HEALTH_TONE.stopped,
      live: false,
    };
  }
  // Running. The process is right here, so this is firsthand and outranks
  // every derived signal - about LIVENESS. Incompatibility is not a liveness
  // claim: the process is running AND this app cannot speak to it, and
  // reading that as "Online" hides the one affordance that fixes it (the
  // update action gates on `update-required`, which only `leaseHealth` can
  // word). Fall through for exactly that lease; every other derived signal
  // stays outranked.
  const { lease, authorityAttached } = options;
  if (
    authorityAttached &&
    lease !== null &&
    lease.status === "dead" &&
    lease.dead.reason === "incompatible"
  ) {
    return null;
  }
  return {
    state: "online",
    label: "Online",
    detail: "Running on this computer.",
    tone: HOST_HEALTH_TONE.online,
    live: true,
  };
}

/** What the dead-reason table needs to word an answer. */
interface DeadHealthContext {
  readonly item: HostListItem | null;
  readonly isLocalMachine: boolean;
  readonly nowMs: number;
}

/**
 * Keyed on the CONTRACT's own `reason` union, not on a hand-written copy of
 * it — the same construction as `tile-host-load-copy.ts`'s `DEAD_MESSAGE`, and
 * for the same reason. A fifth dead reason added to `HostLeaseDeadState` fails
 * to compile HERE, naming its missing key, rather than arriving at runtime and
 * routing silently to whichever arm a `default` happened to point at.
 *
 * That failure mode is not hypothetical, and this surface is where it did the
 * most damage: rendering `plan-restricted` hosts as "offline" is the months-long
 * defect that sent free-tier users to debug a network fault they did not have,
 * while the one thing that would have fixed it — an upgrade — went unmentioned.
 * The two arms below are deliberately different in remedy, not just in wording.
 */
const DEAD_HEALTH: Record<
  HostLeaseDeadState["reason"],
  (context: DeadHealthContext) => HostHealth
> = {
  offline: (context) => ({
    state: "offline",
    label: "Offline",
    detail: capitalize(
      formatLastSeen(context.item?.status.lastSeenAt ?? null, context.nowMs),
    ),
    tone: HOST_HEALTH_TONE.offline,
    live: false,
  }),
  "plan-restricted": (context) => ({
    state: "local-only",
    label: "Local only",
    // The copy has to depend on WHOSE machine this is, because the claim
    // "reachable from this computer" is only true for one of them. It said
    // that unconditionally once, and for a remote row it was a fabrication
    // twice over: the machine is somewhere else, and the plan is the reason no
    // route to it exists. Both arms state the remedy — an upgrade — because
    // that is the one thing a person can act on.
    detail: context.isLocalMachine
      ? "Reachable on this computer. Remote access needs a paid plan."
      : "Not reachable from here — remote access needs a paid plan.",
    tone: HOST_HEALTH_TONE["local-only"],
    live: false,
  }),
  removed: () => ({
    state: "removed",
    label: "Removed",
    detail: "This host was removed from your account.",
    tone: HOST_HEALTH_TONE.removed,
    live: false,
  }),
  incompatible: () => ({
    state: "update-required",
    label: "Update required",
    // The versions themselves are deliberately NOT here. This is a status
    // line on a row; the structured skew (host version, minimum supported,
    // reason code) belongs with the action that acts on it, which reads it
    // from the lease directly — see `host-update-required-action.tsx`.
    detail: "This host is running an older version than this app supports.",
    tone: HOST_HEALTH_TONE["update-required"],
    live: false,
  }),
};

/**
 * The authority's verdict, or `null` when it has not reached one.
 *
 * The two `null` arms are the fail-closed guard, and they are the reason this
 * function exists rather than being folded into the caller:
 *
 *   - **not attached** — the bridge mounts in a parent effect and React runs
 *     child effects first, so every consumer renders at least once before the
 *     authority has spoken. Reading that window as evidence would flash a dead
 *     fleet on every cold start.
 *   - **`connecting`** — the contract's non-committal state: neither usable
 *     nor dead. It is also what an unknown `status` parses to at the boundary
 *     and what every lease reads while evidence producers are still warming
 *     up, so treating it as a failure would turn "we have not found out yet"
 *     into "it is broken" for the whole fleet at once.
 *
 * `degraded` is the opposite case and is deliberately NOT a fall-through: it
 * is a live SERVING state (the lease is usable), so it renders as Online with
 * the impairment as nuance rather than demoting the host.
 */
function leaseHealth(options: DeriveHostHealthOptions): HostHealth | null {
  const { lease, authorityAttached } = options;
  if (!authorityAttached || lease === null) return null;
  switch (lease.status) {
    case "connecting":
      return null;
    case "ready":
      return {
        state: "online",
        label: "Online",
        detail: null,
        tone: HOST_HEALTH_TONE.online,
        live: true,
      };
    case "degraded":
      return {
        state: "online",
        label: "Online",
        detail: "Connection is unstable.",
        tone: HOST_HEALTH_TONE.online,
        live: true,
      };
    case "restarting-expected":
      return {
        state: "restarting",
        label: "Restarting…",
        detail: "Expected restart — reconnecting.",
        tone: HOST_HEALTH_TONE.restarting,
        live: false,
      };
    case "dead":
      return DEAD_HEALTH[lease.dead.reason]({
        item: options.item,
        isLocalMachine: options.isLocalMachine,
        nowMs: options.nowMs,
      });
  }
}

/**
 * The weakest answer: what the account's registry says, for a host nothing has
 * dialled. Reached only when the two firsthand steps above declined.
 */
function registryHealth(options: DeriveHostHealthOptions): HostHealth {
  const { item, isLocalMachine, hasLiveSession, nowMs } = options;
  if (item === null) {
    // In the runtime directory but not the cloud registry, and no lease: we
    // can reach it, yet nothing vouches for its liveness. Claiming either
    // Online or Offline would be an invention.
    return {
      state: "unknown",
      label: "Status unknown",
      detail: "This host hasn't reported to your account yet.",
      tone: HOST_HEALTH_TONE.unknown,
      live: false,
    };
  }
  const presence = deriveHostPresence({
    status: item.status,
    hasLiveSession,
    planAllowsRemote: options.planAllowsRemote,
    nowMs,
  });
  switch (presence.reading) {
    case "online":
      // Reached only through the live-session override, which is firsthand.
      return {
        state: "online",
        label: "Online",
        detail: null,
        tone: HOST_HEALTH_TONE.online,
        live: presence.showLiveDot,
      };
    case "reported-reachable":
      // F26. The account heard from this host within the lease TTL and nothing
      // here has spoken to it, so the row says what is true — that the report
      // exists — instead of asserting a liveness no layer in this app has
      // observed. The moment anything dials it, the lease answers above and
      // this arm stops being reached.
      return {
        state: "reported-reachable",
        label: "Reported reachable",
        detail:
          "Your account last heard from this host. Nothing has connected to it from here yet.",
        tone: HOST_HEALTH_TONE["reported-reachable"],
        live: false,
      };
    case "local-only":
      return DEAD_HEALTH["plan-restricted"]({ item, isLocalMachine, nowMs });
    case "unknown":
      return {
        state: "unknown",
        label: "Status unknown",
        detail: "Live status is unavailable right now — this may be stale.",
        tone: HOST_HEALTH_TONE.unknown,
        live: false,
      };
    case "client-offline":
      return {
        state: "viewer-offline",
        label: "You're offline",
        detail: "Reconnect to see this host's status.",
        tone: HOST_HEALTH_TONE["viewer-offline"],
        live: false,
      };
    case "offline":
      return DEAD_HEALTH.offline({ item, isLocalMachine, nowMs });
  }
}

function capitalize(value: string | null): string | null {
  if (value === null) return null;
  return capitalizeString(value);
}

function capitalizeString(value: string): string {
  if (value.length === 0) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
