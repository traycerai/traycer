import {
  hostListResponseSchema,
  type HostListItem,
  type HostListResponse,
  type HostStatusDTO,
} from "@traycer/protocol/host/host-status";
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
 * Projects a registry row to a directory entry. `websocketUrl` is the relay's
 * fixed WS attach endpoint (S2/T14) — every remote host shares the same
 * endpoint; the relay routes by the opaque `rendezvousId` inside the
 * CS-minted attach grant, never by this URL. `status` is a coarse, point-in-
 * time snapshot derived from the presence lease, consumed by the existing
 * open-time reachability gate (`useHostReachability`) exactly as a local
 * host's `status` already is — it is NOT the honest `viewerReachability` pill
 * (Architecture §7), which only a real connection attempt at tab-open time may
 * set. `version` shows the last-reported app version.
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
    status:
      item.status.presenceLease === "expired" ? "unavailable" : "available",
    remoteStatus: item.status,
    publicKey: item.publicKey,
  };
}

/**
 * The stubbed fetcher the `HostDirectoryService` uses by default. Returns an
 * empty hosts result so the merged directory has a stable shape and stays
 * local-only in S1 (feeding unconnectable remote entries into the selectable
 * directory would be a premature connect affordance / auto-bind hazard).
 * Swapped for `createRemoteHostFetcher` when the relay lands (S2).
 */
export type RemoteHostFetcher = () => Promise<RemoteHostFetchOutcome>;

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
 */
export function createRemoteHostFetcher(
  deps: RemoteHostFetcherDeps,
): RemoteHostFetcher {
  return async () => {
    const bearerToken = deps.getBearerToken();
    if (bearerToken === null) {
      return { kind: "signed-out" };
    }
    const result = await deps.listHosts(bearerToken);
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
