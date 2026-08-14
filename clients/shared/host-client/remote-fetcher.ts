import {
  hostListResponseSchema,
  type HostListItem,
  type HostListResponse,
  type HostStatusDTO,
} from "@traycer/protocol/host/host-status";
import type { AuthEra } from "../auth/request-context-provider";
import type { HostDirectoryEntry } from "./host-directory";

/**
 * Remote-host discovery for Remote Host Support S1 (Architecture §7, §9).
 *
 * `fetchRegisteredHostsViaHttp` is the raw `GET /api/v3/hosts` call — a pure
 * HTTP helper (sibling to `auth-validation.ts`) that authenticates with the
 * user bearer and returns the parsed status envelope. Like the auth helpers it
 * is transport-only, so a shell may run it wherever CORS permits: desktop runs
 * it in Electron main (renderer-origin CORS would otherwise block authn-v3,
 * whose CORS allow-list is the web dashboard origin only), browser/dev shells
 * call it directly. The renderer reaches it through
 * `IRunnerHost.listRegisteredHosts(...)`.
 *
 * The GUI's `HostDirectoryService` composes `RemoteHostFetcher` with the runner
 * host's local snapshot. `fetchRemoteHosts` is the empty default the service
 * falls back to; `createRemoteHostFetcher` builds the real fetcher (used to feed
 * remote entries into the connectable directory in S2, once a relay exists).
 */

/** Per-request budget, mirrors the auth helper's `AUTH_FETCH_TIMEOUT_MS`. */
const HOST_LIST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Outcome of a `GET /api/v3/hosts` call. A discriminated, structured-clone-safe
 * shape (mirrors the auth outcomes) so it crosses the Electron IPC boundary
 * unchanged:
 *  - `ok`            — the validated envelope.
 *  - `unauthorized`  — the bearer was rejected (401/403); the caller decides
 *                      whether to revalidate. Never destructive here.
 *  - `network-error` — transient transport/timeout/5xx or a malformed body; the
 *                      query layer surfaces it as retriable, not "no hosts".
 */
export type HostListFetchResult =
  | { readonly kind: "ok"; readonly response: HostListResponse }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "network-error" };

function hostsApiUrl(authnBaseUrl: string): string {
  return new URL(
    "api/v3/hosts",
    authnBaseUrl.endsWith("/") ? authnBaseUrl : `${authnBaseUrl}/`,
  ).toString();
}

/**
 * Fetches the caller's host registry + live status from authn-v3 with the user
 * bearer. Never throws — every failure collapses into the discriminated result
 * so callers branch on `kind` instead of `try`/`catch`.
 */
export async function fetchRegisteredHostsViaHttp(
  authnBaseUrl: string,
  bearerToken: string,
): Promise<HostListFetchResult> {
  let response: Response;
  try {
    response = await fetch(hostsApiUrl(authnBaseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(HOST_LIST_FETCH_TIMEOUT_MS),
    });
  } catch {
    // A thrown `fetch` — transport failure or the per-attempt timeout — is
    // transient and retriable.
    return { kind: "network-error" };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "network-error" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "network-error" };
  }

  const parsed = hostListResponseSchema.safeParse(body);
  if (!parsed.success) {
    // A 2xx that does not match the contract (proxy HTML, a server-side shape
    // drift) is treated as transient rather than mis-rendered — the mirror
    // fails closed (see `host-status.ts`).
    return { kind: "network-error" };
  }
  return { kind: "ok", response: parsed.data };
}

/**
 * A remote `HostDirectoryEntry` enriched with the live status DTO (Architecture
 * §7). Structurally a superset of `HostDirectoryEntry`, so it satisfies every
 * base-directory consumer while carrying the DTO for status-aware surfaces.
 *
 * `publicKey` is the host's registry-published static X25519 key — carried
 * through from the DTO so the S2 remote transport (T12) can run the Noise-NK
 * handshake to the right host. It is present from S1 (the DTO always carries it)
 * even though the host is not connectable until the relay lands.
 */
export type RemoteHostDirectoryEntry = HostDirectoryEntry & {
  readonly remoteStatus: HostStatusDTO;
  readonly publicKey: string;
  /**
   * The fuse-vs-lease RECOVERY-DIAL window (F7, narrowed by the cold review's
   * P1): `true` when the cloud says `offline` but the host was seen recently
   * enough that the relay's host-leg fuse COULD still be holding its socket.
   * Recency is NOT attachment evidence - a host that cleanly detached or
   * crashed a minute ago carries exactly the same recent `lastSeenAt` as a
   * lease lapse the fuse is riding out - so this flag never upgrades the
   * `offline` verdict itself. Its ONLY consumer is
   * {@link isConfirmedTransportRefusal}, which lets a recovery dial be
   * attempted inside the window; whether the host is actually alive is settled
   * by that dial's outcome (a ready live session), never by this flag.
   * Computed once at projection time from `remoteStatus.lastSeenAt`
   * (see {@link isWithinRelayFuseGrace}) so the render-time gates stay pure.
   * Always `false` for any connectivity other than `offline`.
   */
  readonly relayFuseGrace: boolean;
};

/**
 * Narrows a directory entry to a remote one carrying its status DTO + public
 * key. Used by the remote transport branch in `useHostClientFor` to reach the
 * Noise-NK host key without widening the base `HostDirectoryEntry` shape.
 */
export function isRemoteHostDirectoryEntry(
  entry: HostDirectoryEntry,
): entry is RemoteHostDirectoryEntry {
  return (
    entry.kind === "remote" && "remoteStatus" in entry && "publicKey" in entry
  );
}

/**
 * WHY a directory entry cannot be dialed — the distinction the coarse bit
 * erases.
 *
 * `HostTransportDialability` answers one question ("can this client dial it?")
 * and that is the right question for the transport. It is the wrong question
 * for the UI, because three very different situations collapse into
 * `not-dialable`:
 *
 *  - `offline`         — the host is positively not attached. Saying so is
 *                        honest, and this is the only one that may render as
 *                        "offline" or count as evidence a host is dead.
 *                        (Inside the relay-fuse window a recovery DIAL is
 *                        still attempted - see `isConfirmedTransportRefusal` -
 *                        but the verdict stays `offline`: recency cannot
 *                        distinguish a lease lapse from a clean detach or a
 *                        crash, so it never upgrades the death semantic.)
 *  - `plan-restricted` — the account's plan has no remote hosts, so this host
 *                        never attaches by design. The remedy is an upgrade,
 *                        not a retry, and calling it "offline" sends a person
 *                        to restart a machine that is working fine.
 *  - `indeterminate`   — the cloud could not read liveness. We learned NOTHING.
 *                        Rendering it as dead is the false-Offline-when-blind
 *                        bug, one layer below where that rule is usually
 *                        stated: a single degraded Redis read must not replace
 *                        a live chat with a "host is offline" banner.
 *
 * Derived in ONE place on purpose. The previous shape had each consumer read
 * the coarse boolean and reach its own conclusion, which is how the presenter
 * and the tiles ended up disagreeing about the same host. A consumer may
 * legitimately treat two of these the same — but it has to say so against the
 * named verdict, not by never learning the difference.
 */
export type HostUnavailability =
  "offline" | "plan-restricted" | "indeterminate";

/**
 * The relay DO's hard cap on how long a host leg may stay attached without a
 * fresh re-auth: the base host-leg interval (15 min) times the emergency fuse
 * multiplier, clamped to 4h (workers/relay-do `MAX_REAUTH_INTERVAL_MS`). During
 * a credential-plane incident an operator raises that multiplier, so the relay
 * keeps holding a host's socket for up to this long while authn's 15-min
 * presence lease has already lapsed - the false-`offline` window this bound
 * reconciles. Mirrored here because the OSS client cannot import the worker's
 * config (exactly as `host-transport/remote/config.ts` already mirrors the
 * relay's re-auth cadences); it MUST track that worker constant.
 */
export const RELAY_FUSE_MAX_ATTACH_MS = 4 * 60 * 60 * 1000;

/**
 * How far AHEAD of this client's clock a `lastSeenAt` may sit and still anchor
 * the fuse window. `lastSeenAt` is stamped by the cloud, so a client clock
 * lagging the server by a little legitimately reads a just-seen host as "seen
 * in the future" - refusing those outright would deny the recovery dial to
 * exactly the freshest candidates. Past this allowance the timestamp is not
 * skew but a corrupt anchor, and a corrupt future timestamp must not hold the
 * dial window open (a negative age reads as "within grace" for as long as it
 * takes the clock to catch up to it). Five minutes is generous against real
 * NTP drift while staying tiny next to the 4h window it guards.
 */
export const RELAY_FUSE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Whether an `offline` verdict is recent enough that the relay's host-leg fuse
 * COULD still be holding the leg (F7), i.e. whether a recovery dial is worth
 * attempting.
 *
 * authn's presence lease expires ~15 min after a host stops re-asserting, but
 * during a credential-plane incident the relay keeps an attached leg up to
 * {@link RELAY_FUSE_MAX_ATTACH_MS}. In that window the cloud reports `offline`
 * for a host the relay may still hold. Crucially, recency is NOT attachment
 * evidence: a host that cleanly detached, crashed, or lost power a minute ago
 * stops advancing `lastSeenAt` in exactly the same way, so inside the window
 * the two cases are observationally identical from this DTO. This predicate
 * therefore bounds only WHERE A RECOVERY DIAL IS WORTH ATTEMPTING
 * (`isConfirmedTransportRefusal`); it must never stand in for liveness - the
 * dial's own outcome (a ready session, or a failure) is what settles that.
 * Past the cap the fuse has certainly blown and even the dial is refused.
 * Never grace for a null/unparseable `lastSeenAt` (nothing anchors the
 * window) or a non-`offline` verdict.
 *
 * `nowMs` is passed in rather than read here so every caller stays pure; the
 * projection reads the clock once at fetch time.
 */
export function isWithinRelayFuseGrace(
  status: HostStatusDTO,
  nowMs: number,
): boolean {
  if (status.connectivity !== "offline") {
    return false;
  }
  if (status.lastSeenAt === null) {
    return false;
  }
  const lastSeenMs = Date.parse(status.lastSeenAt);
  if (Number.isNaN(lastSeenMs)) {
    return false;
  }
  const ageMs = nowMs - lastSeenMs;
  if (ageMs < -RELAY_FUSE_MAX_CLOCK_SKEW_MS) {
    // A `lastSeenAt` further ahead of this clock than plausible skew is a
    // corrupt anchor, not a recent sighting: its negative age would otherwise
    // read as "within grace" until the clock catches up to it. A small future
    // value (client clock lagging the cloud stamp) still anchors the window.
    return false;
  }
  return ageMs < RELAY_FUSE_MAX_ATTACH_MS;
}

/**
 * The reason an entry is not dialable, or `null` when it is.
 *
 * A `remote` entry carries the cloud's verdict on itself (`remoteStatus`), and
 * that is what this reads. Anything else — a local host, a mock, or the
 * non-dialable twin the directory substitutes for this machine while its
 * process is down — has no relay verdict to consult and reports `offline`,
 * which is correct for it: locality is decided by a direct read of the process,
 * never by this.
 */
export function hostUnavailability(
  entry: HostDirectoryEntry,
): HostUnavailability | null {
  if (entry.transportDialability === "dialable") {
    return null;
  }
  if (!isRemoteHostDirectoryEntry(entry)) {
    return "offline";
  }
  switch (entry.remoteStatus.connectivity) {
    case "local-only":
      return "plan-restricted";
    case "unknown":
      return "indeterminate";
    case "offline":
      // `offline` is authoritative, fuse window or not (cold review P1). An
      // earlier F7 shape rewrote a fuse-window `offline` to `indeterminate`
      // here, which let a recent `lastSeenAt` - equally consistent with a
      // clean detach or a crash one minute ago - suppress failover, the dead
      // surface, and notification-action refusal for up to four hours on a
      // genuinely dead host. Recency buys exactly one thing, the recovery
      // dial (`isConfirmedTransportRefusal`); death is only ever overridden
      // by that dial actually succeeding (the live-session evidence every
      // destructive gate already honours).
      return "offline";
    case "connectable":
      // Unreachable in practice (`connectable` is exactly what makes an entry
      // `dialable` above). Reported as indeterminate rather than offline so a
      // future mapper change that breaks that correspondence degrades into
      // "we don't know" instead of into a false death claim.
      return "indeterminate";
  }
}

/**
 * Whether the directory is POSITIVELY refusing this route, as opposed to
 * failing to answer.
 *
 * Two refusals are real and permanent-until-something-changes: the host is
 * confirmed detached (`offline`), or the account's plan has no remote route to
 * it (`plan-restricted` — correct to refuse, since no relay attach exists to
 * dial; the UI's job is to say "Local only" rather than "offline", which is
 * `useHostReachability`'s reason field, not this).
 *
 * `indeterminate` is not a refusal — it is the absence of an answer, and the
 * transport's response to an absent answer is to try.
 *
 * `hasReadyLiveSession` outranks ALL of it, and that is the single rule this
 * function exists to state once:
 *
 *   **a ready live session keeps the transport alive under any verdict;
 *   confirmed refusals gate NEW dials only.**
 *
 * Two authorities used to answer this and they disagreed. `useHostReachability`
 * already held that an open E2E session outranks a cloud verdict, while this
 * gate never saw session evidence and nulled the key anyway — so the registries
 * released the very handle the hook was protecting, and the committed tests
 * pinned both halves of the contradiction.
 *
 * The hook's side is the correct one, and the asymmetry is the reason: an open
 * session is firsthand, present-tense proof, while a verdict is a lease read
 * that is second-hand and possibly minutes stale. If the host really is dead
 * the session discovers it through its own death path within seconds and tears
 * down for a reason it actually observed. Killing it from a directory read
 * instead replaces a working tab with a dead one on weaker evidence — and if
 * the read was wrong, nothing brings the tab back.
 *
 * `plan-restricted` mid-session (a downgrade with a session open) follows the
 * same rule deliberately: the existing session survives, and the next dial
 * refuses with the upgrade copy.
 *
 * Lives here rather than beside the GUI's `hostTransportKey` because it is
 * asked by more than one gate, and the gates MUST agree. `host-client`'s rebind
 * sweep and the binding-authority registry ask it to decide whether a directory
 * re-emit changed the route enough to cancel in-flight work; `transport-key`
 * asks it to decide whether to dial. When those disagreed, the socket survived
 * a verdict flip while everything riding on it was cancelled underneath.
 */
export function isConfirmedTransportRefusal(
  entry: HostDirectoryEntry,
  hasReadyLiveSession: boolean,
): boolean {
  if (hasReadyLiveSession) {
    return false;
  }
  const unavailability = hostUnavailability(entry);
  if (unavailability === "offline" && isRelayFuseRecoveryCandidate(entry)) {
    // F7's recovery affordance, and the ONLY thing the fuse window buys: an
    // `offline` recent enough that the relay fuse could still hold the leg is
    // dialed rather than refused. The asymmetry is the same one
    // `indeterminate` rides: a dial that fails is cheap and recoverable,
    // while refusing the dial during the exact credential-plane incident the
    // fuse exists to ride out abandons a working host. The dial's OUTCOME -
    // not this window - is what feeds every death gate (a success becomes the
    // ready-session evidence above).
    return false;
  }
  return unavailability === "offline" || unavailability === "plan-restricted";
}

/**
 * Whether a recovery dial is worth attempting at an `offline` entry: the entry
 * is remote and its `offline` verdict is recent enough that the relay's
 * host-leg fuse could still be holding the leg (see
 * {@link isWithinRelayFuseGrace} - recency bounds the dial window, it is NOT
 * attachment or liveness evidence). Consumed by
 * {@link isConfirmedTransportRefusal} only; the death gates
 * ({@link isConfirmedHostDeath}, and every surface reading
 * {@link hostUnavailability}) deliberately never read it.
 */
export function isRelayFuseRecoveryCandidate(
  entry: HostDirectoryEntry,
): boolean {
  return isRemoteHostDirectoryEntry(entry) && entry.relayFuseGrace;
}

/**
 * Whether an entry is positive evidence that the host is DEAD — the gate for
 * anything destructive or hard to undo: dead-tile banners, "permanently
 * closed" notifications, and re-homing the app-wide selection.
 *
 * Deliberately narrower than "not dialable". `indeterminate` fails this gate
 * because a failed liveness read is not evidence about the host, and
 * `plan-restricted` fails it because the host is not dead at all — it is
 * working exactly as the account's plan says it should.
 *
 * `hasLiveSession` outranks everything: a client holding an open E2E session
 * has firsthand proof the host is up, which beats any verdict the cloud
 * reaches about it minutes later and through a different leg.
 *
 * A fuse-window `offline` (F7) does NOT fail this gate (cold review P1): a
 * recent `lastSeenAt` is equally consistent with a lease lapse the fuse is
 * riding out and with a clean detach or crash a minute ago, so recency is not
 * evidence about the host. What protects the credential-lapse case is the
 * recovery dial the fuse window keeps open (`isConfirmedTransportRefusal`):
 * when the leg really is still attached, that dial succeeds within seconds and
 * its ready session flips `hasLiveSession` here - firsthand evidence - before
 * the two-read failover streak can complete. When the dial fails, the host is
 * dead and this gate firing is exactly right.
 */
export function isConfirmedHostDeath(
  entry: HostDirectoryEntry,
  hasLiveSession: boolean,
): boolean {
  if (hasLiveSession) {
    return false;
  }
  return hostUnavailability(entry) === "offline";
}

/**
 * Projects a registry row to a directory entry. `websocketUrl` is the relay's
 * fixed WS attach endpoint (S2/T14) — every remote host shares the same
 * endpoint; the relay routes by the opaque `rendezvousId` inside the
 * CS-minted attach grant, never by this URL. `version` shows the last-reported
 * app version.
 *
 * `transportDialability` answers exactly one question — can this client dial
 * the host right now — so it is `dialable` if and only if the relay holds a
 * live attachment for it (`connectivity === "connectable"`). Every other
 * connectivity value is a DIFFERENT reason for the same dialing answer, and
 * the directory must not distinguish them: `local-only` (the plan gate refuses
 * the attach), `unknown` (we could not read liveness) and `offline` all mean
 * the dial would not arrive. The honest per-reason copy is the derivation
 * layer's job — {@link hostUnavailability} keeps the reason, and the
 * `local-only` upgrade prompt and the "status unknown" wording branch on it
 * where there is room to say why.
 *
 * `unknown` is the one that would be tempting to admit, and must not be: a
 * blind liveness read is not evidence of reachability, and letting it through
 * would put a live-looking, selectable row in the directory on the strength of
 * a failed Redis call. It is NOT the honest `viewerReachability` pill
 * (Architecture §7) either, which only a real connection attempt at tab-open
 * may set.
 */
export function hostListItemToDirectoryEntry(
  item: HostListItem,
  relayBaseUrl: string,
): RemoteHostDirectoryEntry {
  return {
    hostId: item.hostId,
    label: item.displayName === null ? item.hostId : item.displayName,
    kind: "remote",
    websocketUrl: relayBaseUrl,
    version: item.status.appVersion,
    transportDialability:
      item.status.connectivity === "connectable" ? "dialable" : "not-dialable",
    remoteStatus: item.status,
    publicKey: item.publicKey,
    // Reconciled once here (fetch time, not render) so the render-time
    // dialability/death gates stay pure - see isWithinRelayFuseGrace.
    relayFuseGrace: isWithinRelayFuseGrace(item.status, Date.now()),
  };
}

/**
 * The stubbed fetcher the `HostDirectoryService` uses by default. Returns an
 * empty hosts result so the merged directory has a stable shape and stays
 * local-only in S1 (feeding unconnectable remote entries into the selectable
 * directory would be a premature connect affordance / auto-bind hazard).
 * Swapped for `createRemoteHostFetcher` when the relay lands (S2).
 *
 * The {@link AuthEra} names the credential era the refresh was ISSUED FOR. A
 * fetcher backed by a real credential must check it against the era of the
 * bearer it is about to send and refuse rather than send a mismatched one —
 * the whole point is that "the current bearer" and "the bearer this refresh
 * is for" are two different questions during an identity transition. A
 * fetcher that holds no credential (the stub, and test doubles) ignores it.
 */
export type RemoteHostFetcher = (
  era: AuthEra,
) => Promise<RemoteHostFetchOutcome>;

/**
 * Outcome contract every `RemoteHostFetcher` returns, so
 * `HostDirectoryService.refresh()` (T20 / audit P4) can tell a genuine
 * (possibly empty) hosts result apart from a legitimate sign-out clear and a
 * transient failure instead of collapsing all three into an empty list:
 *  - `hosts`      — a genuine registry result; replaces `remoteEntries`.
 *  - `signed-out` — no bearer (or one the registry rejected); a legitimate
 *                   clear, same as today.
 *  - `failed`     — transport/timeout/non-ok/parse failure; the directory
 *                   must retain its last-known `remoteEntries` instead of
 *                   wiping them and unbinding an active remote selection.
 */
export type RemoteHostFetchOutcome =
  | { readonly kind: "hosts"; readonly entries: readonly HostDirectoryEntry[] }
  | { readonly kind: "signed-out" }
  | { readonly kind: "failed" };

export const fetchRemoteHosts: RemoteHostFetcher = async () => {
  return { kind: "hosts", entries: [] };
};

export interface RemoteHostFetcherDeps {
  /**
   * Runs the `GET /api/v3/hosts` call for a bearer. Desktop passes the
   * runner-host bridge (Electron main); browser/dev pass
   * `(bearer) => fetchRegisteredHostsViaHttp(authnBaseUrl, bearer)`.
   */
  readonly listHosts: (bearerToken: string) => Promise<HostListFetchResult>;
  /** Reads the current user bearer, or `null` when signed out. */
  readonly getBearerToken: () => string | null;
  /** The relay's fixed WS attach endpoint (`IRunnerHost.relayBaseUrl`, S2/T14). */
  readonly relayBaseUrl: string;
}

/**
 * Builds a `RemoteHostFetcher` for the directory service (S2 wiring). No
 * bearer, or one the registry rejected (`unauthorized`), maps to
 * `signed-out` — a legitimate clear, matching
 * `AuthService.fetchRegisteredHosts()`'s choice not to force a sign-out from
 * a background list poll. A `network-error` result maps to `failed` so a
 * transient blip never drops the merged directory (T20 / audit P4).
 *
 * The browser/dev shell's fetcher: `getBearerToken` hands back whatever is
 * current, with no era attached, so this cannot honour the era check the
 * desktop path performs. It is not on the desktop composition — the GUI wires
 * `AuthService.fetchRegisteredHosts`, which owns both the bearer and the era
 * it belongs to and refuses a mismatch. A shell that adopts this fetcher for
 * a real credential must supply an era-aware credential read.
 */
export function createRemoteHostFetcher(
  deps: RemoteHostFetcherDeps,
): RemoteHostFetcher {
  return async () => {
    const bearerToken = deps.getBearerToken();
    if (bearerToken === null) {
      return { kind: "signed-out" };
    }
    let result: HostListFetchResult;
    try {
      result = await deps.listHosts(bearerToken);
    } catch {
      // Unlike `fetchRegisteredHostsViaHttp`, the injected seam (desktop's
      // Electron IPC bridge) is not contractually throw-free: a rejected
      // bridge call must collapse into the transient `failed` outcome - the
      // retain-last-known path - rather than rejecting the directory refresh
      // it feeds (T20 / audit P4).
      return { kind: "failed" };
    }
    if (result.kind === "unauthorized") {
      return { kind: "signed-out" };
    }
    if (result.kind === "network-error") {
      return { kind: "failed" };
    }
    return {
      kind: "hosts",
      entries: result.response.hosts.map((item) =>
        hostListItemToDirectoryEntry(item, deps.relayBaseUrl),
      ),
    };
  };
}
