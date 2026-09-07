import {
  hostListResponseSchema,
  type HostListItem,
  type HostListResponse,
  type HostStatusDTO,
} from "@traycer/protocol/host/host-status";
import type { AuthEra } from "../auth/request-context-provider";
import { applyHostKeyPins } from "./host-key-pin";
import type { HostDirectoryEntry } from "./host-directory";

const HOST_LIST_FETCH_TIMEOUT_MS = 10_000;

/**
 * Outcome of a `get /api/v3/hosts` call.
 * A discriminated, structured-clone-safe shape (mirrors the auth outcomes) so it crosses the Electron IPC boundary unchanged: - `ok` - the validated envelope.
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
 * Fetches the caller's host registry + live status from authn-v3 with the user bearer.
 * Never throws - every failure collapses into the discriminated result so callers branch on `kind` instead of `try`/`catch`.
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
  // A thrown `fetch` - transport failure or the per-attempt timeout - is
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
    // A 2xx that does not match the contract (proxy HTML, a server-side shape drift) is treated as transient rather than mis-rendered - the mirror fails closed (see `host-status.ts`).
    return { kind: "network-error" };
  }
  // The one place a host's Noise static key enters this client, so the one place trust-on-first-use can gate it (H11).
  // A host whose key changed is dropped here and never reaches a surface that could offer to dial it.
  return {
    kind: "ok",
    response: {
      ...parsed.data,
      hosts: await applyHostKeyPins(parsed.data.hosts),
    },
  };
}

export type RemoteHostDirectoryEntry = HostDirectoryEntry & {
  readonly remoteStatus: HostStatusDTO;
  readonly publicKey: string;
  /**
   * The fuse-vs-lease recovery-dial window (F7, narrowed by the cold review's P1): `true` when the cloud says `offline` but the host was seen recently enough that the relay's host-leg fuse could still be holding its socket.
   */
  readonly relayFuseGrace: boolean;
  /**
   * Whether the durable host credential check-in is recent enough to be positive process-liveness evidence for a plan-gated account.
   * Free-plan hosts never hold the relay leg, so their `offline` connectivity value is structurally guaranteed and cannot distinguish a running host from a dead one.
   */
  readonly recentHostCheckIn: boolean;
  /**
   * Whether the account's plan includes remote hosts, as of the fetch that produced this entry.
   * Stamped here at projection time (fetch time, not render) exactly as {@link relayFuseGrace} is, so every render-time gate stays a pure function of the entry.
   */
  readonly planAllowsRemote: boolean;
};

/**
 * Narrows a directory entry to a remote one carrying its status DTO + public key.
 * Used by the remote transport branch in `useHostClientFor` to reach the Noise-NK host key without widening the base `HostDirectoryEntry` shape.
 */
export function isRemoteHostDirectoryEntry(
  entry: HostDirectoryEntry,
): entry is RemoteHostDirectoryEntry {
  return (
    entry.kind === "remote" && "remoteStatus" in entry && "publicKey" in entry
  );
}

/**
 * Why a directory entry cannot be dialed - the distinction the coarse bit erases.
 * Saying so is honest, and this is the only one that may render as "offline" or count as evidence a host is dead.
 */
export type HostUnavailability =
  | "offline"
  | "plan-restricted"
  | "indeterminate";

  /**
   * Mirrored here because the oss client cannot import the worker's config (exactly as `host-transport/remote/config.ts` already mirrors the relay's re-auth cadences); it must track that worker constant.
   */
export const RELAY_FUSE_MAX_ATTACH_MS = 4 * 60 * 60 * 1000;

export const RELAY_FUSE_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const PLAN_GATED_HOST_FRESHNESS_MS = 30 * 60 * 1000;

export function hasRecentHostCheckIn(
  status: HostStatusDTO,
  nowMs: number,
): boolean {
  if (status.lastSeenAt === null) {
    return false;
  }
  const lastSeenMs = Date.parse(status.lastSeenAt);
  if (Number.isNaN(lastSeenMs)) {
    return false;
  }
  const ageMs = nowMs - lastSeenMs;
  return (
    ageMs >= -RELAY_FUSE_MAX_CLOCK_SKEW_MS &&
    ageMs < PLAN_GATED_HOST_FRESHNESS_MS
  );
}

/**
 * Whether an `offline` verdict is recent enough that the relay's host-leg fuse could still be holding the leg (F7), i.e. whether a recovery dial is worth attempting.
 * authn's presence lease expires ~15 min after a host stops re-asserting, but during a credential-plane incident the relay keeps an attached leg up to {@link RELAY_FUSE_MAX_ATTACH_MS}.
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
    // A `lastSeenAt` further ahead of this clock than plausible skew is a corrupt anchor, not a recent sighting: its negative age would otherwise read as "within grace" until the clock catches up to it.
    return false;
  }
  return ageMs < RELAY_FUSE_MAX_ATTACH_MS;
}

/**
 * The reason an entry is not dialable, or `null` when it is.
 * A fresh credential check-in therefore reads `plan-restricted`; only a stale or absent one reaches {@link isConfirmedHostDeath}.
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
  if (entry.remoteStatus.connectivity === "local-only") {
    // Transitional response from a pre-cutover server. It carries only the
    // plan fact, not liveness, so it must never become a death claim.
    return "plan-restricted";
  }
  if (entry.remoteStatus.connectivity === "offline") {
    if (!entry.planAllowsRemote && entry.recentHostCheckIn) {
      // Free-plan hosts never hold the relay leg, so `offline` is guaranteed even while healthy.
      return "plan-restricted";
    }
    return "offline";
  }
  if (!entry.planAllowsRemote) {
    // Live or unreadable, the answer is the same and it is deterministic: no
    // route exists for this account, and the remedy is an upgrade.
    return "plan-restricted";
  }
  switch (entry.remoteStatus.connectivity) {
    case "unknown":
      return "indeterminate";
    case "connectable":
      // Unreachable in practice (`connectable` + an allowing plan is exactly what makes an entry `dialable` above).
      // Reported as indeterminate rather than offline so a future mapper change that breaks that correspondence degrades into "we don't know" instead of into a false death claim.
      return "indeterminate";
  }
}

/**
 * Whether the directory is positively refusing this route, as opposed to failing to answer.
 * `indeterminate` is not a refusal - it is the absence of an answer, and the transport's response to an absent answer is to try.
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
    // F7's recovery affordance, and the only thing the fuse window buys: an `offline` recent enough that the relay fuse could still hold the leg is dialed rather than refused.
    // The dial's outcome - not this window - is what feeds every death gate (a success becomes the ready-session evidence above).
    return false;
  }
  return unavailability === "offline" || unavailability === "plan-restricted";
}

/**
 * Consumed by {@link isConfirmedTransportRefusal} only; the death gates ({@link isConfirmedHostDeath}, and every surface reading {@link hostUnavailability}) deliberately never read it.
 */
export function isRelayFuseRecoveryCandidate(
  entry: HostDirectoryEntry,
): boolean {
  return isRemoteHostDirectoryEntry(entry) && entry.relayFuseGrace;
}

/**
 * Whether an entry is positive evidence that the host is dead - the gate for anything destructive or hard to undo: dead-tile banners, "permanently closed" notifications, and re-homing the app-wide selection.
 * It now sees relay connectivity plus the plan-agnostic credential check-in: a plan-gated host reaches this gate only once that check-in is stale or absent ({@link hostUnavailability}).
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
 * Projects a registry row to a directory entry.
 * `websocketUrl` is the relay's fixed WS attach endpoint (S2/T14) - every remote host shares the same endpoint; the relay routes by the opaque `rendezvousId` inside the CS-minted attach grant, never by this URL.
 */
export function hostListItemToDirectoryEntry(
  item: HostListItem,
  relayBaseUrl: string,
  planAllowsRemote: boolean,
): RemoteHostDirectoryEntry {
  const nowMs = Date.now();
  return {
    hostId: item.hostId,
    label: item.displayName === null ? item.hostId : item.displayName,
    kind: "remote",
    websocketUrl: relayBaseUrl,
    version: item.status.appVersion,
    transportDialability:
      item.status.connectivity === "connectable" && planAllowsRemote
        ? "dialable"
        : "not-dialable",
    remoteStatus: item.status,
    publicKey: item.publicKey,
    // Both flags are reconciled once here (fetch time, not render) so the render-time dialability/death gates stay pure - see isWithinRelayFuseGrace and RemoteHostDirectoryEntry.planAllowsRemote.
    relayFuseGrace:
      planAllowsRemote && isWithinRelayFuseGrace(item.status, nowMs),
    recentHostCheckIn: hasRecentHostCheckIn(item.status, nowMs),
    planAllowsRemote,
  };
}

export type RemoteHostFetcher = (
  era: AuthEra,
) => Promise<RemoteHostFetchOutcome>;

/**
 * - `signed-out` - no bearer (or one the registry rejected); a legitimate clear, same as today.
 * - `failed` - transport/timeout/non-ok/parse failure; the directory must retain its last-known `remoteEntries` instead of wiping them and unbinding an active remote selection.
 */
export type RemoteHostFetchOutcome =
  | { readonly kind: "hosts"; readonly entries: readonly HostDirectoryEntry[] }
  | { readonly kind: "signed-out" }
  | { readonly kind: "failed" };

export const fetchRemoteHosts: RemoteHostFetcher = async () => {
  return { kind: "hosts", entries: [] };
};

export interface RemoteHostFetcherDeps {
  /** Runs the `get /api/v3/hosts` call for a bearer. */
  readonly listHosts: (bearerToken: string) => Promise<HostListFetchResult>;
  /** Reads the current user bearer, or `null` when signed out. */
  readonly getBearerToken: () => string | null;
  /**
   * Reads whether the account's plan includes remote hosts, at fetch time - the second axis every projected entry is stamped with (see {@link RemoteHostDirectoryEntry.planAllowsRemote}).
   * Read per fetch rather than captured once, so a purchase or a downgrade is reflected by the next poll.
   */
  readonly getPlanAllowsRemote: () => boolean;
  /** The relay's fixed WS attach endpoint (`IRunnerHost.relayBaseUrl`, S2/T14). */
  readonly relayBaseUrl: string;
}

/**
 * Builds a `RemoteHostFetcher` for the directory service (S2 wiring).
 * A `network-error` result maps to `failed` so a transient blip never drops the merged directory (T20 / audit P4).
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
      return { kind: "failed" };
    }
    if (result.kind === "unauthorized") {
      return { kind: "signed-out" };
    }
    if (result.kind === "network-error") {
      return { kind: "failed" };
    }
    // Read once per fetch, after the list is in hand, so every entry in one emission is stamped with the same plan answer - a mid-map flip would otherwise produce a directory whose rows disagree about the account.
    const planAllowsRemote = deps.getPlanAllowsRemote();
    return {
      kind: "hosts",
      entries: result.response.hosts.map((item) =>
        hostListItemToDirectoryEntry(item, deps.relayBaseUrl, planAllowsRemote),
      ),
    };
  };
}
