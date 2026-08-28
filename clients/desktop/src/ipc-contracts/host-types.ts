/**
 * Plain-data mirror of `LocalHostSnapshot` from
 * `@traycer-clients/shared/platform/runner-host`. The Electron bridge must not
 * import the shared module directly (Electron main/preload are CommonJS and
 * live outside the shared package's module resolution) - we duplicate the
 * shape here so `contextBridge` serializes a plain object while the renderer
 * consumes the fully typed shared interface.
 */
import type { LiveHostAvailability } from "@traycer-clients/shared/host-client/host-directory";
import type { HostListResponse } from "@traycer/protocol/host/host-status";

export interface DesktopLocalHostSnapshot {
  readonly hostId: string;
  readonly websocketUrl: string;
  readonly version: string;
  readonly pid: number;
  readonly systemHostName: string;
  readonly displayName: string;
}

/**
 * What `HostLifecycle` actually PUBLISHES - the identity above plus how well
 * that host is currently answering.
 *
 * Kept distinct from {@link DesktopLocalHostSnapshot}, which is the pid.json
 * identity shape and is produced by a parser that knows nothing about
 * reachability. Only the lifecycle - the one component that owns both the
 * probe and the liveness check - is entitled to stamp `availability`, so the
 * field is added exactly at that boundary rather than being defaulted by every
 * upstream reader.
 *
 * There is no `"unavailable"` member: absence of a host is carried by the
 * snapshot being `null`. `busy` exists so that a live-but-unresponsive host is
 * no longer indistinguishable from that null - before this field the ONLY
 * signal the desktop could send the renderer was "snapshot or nothing", which
 * is why a single timed-out loopback probe read as a dead machine.
 */
export interface DesktopPublishedHostSnapshot extends DesktopLocalHostSnapshot {
  readonly availability: LiveHostAvailability;
}

export interface DesktopTrayEpic {
  readonly epicId: string;
  readonly title: string;
  readonly subtitle: string;
}

export type DesktopTrayIndicatorState = "idle" | "active" | "attention";

/**
 * Desktop IPC re-export of the shared host-list / version-policy and
 * Devices & Sessions result contracts consumed by `auth-bridge.ts`. The
 * canonical definitions live in `@traycer-clients/shared/host-client/*` and
 * `@traycer-clients/shared/auth/devices-sessions-fetcher`; this file lets the
 * Electron preload bridge import them from `src/ipc-contracts/` (per the
 * preload boundary rule) rather than reaching into the shared package.
 */
export type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * One registry read, fanned out to every window (redesign P4.1/F22, §1b).
 *
 * Main owns the poll cadence, so N windows produce ONE `GET /api/v3/hosts`
 * instead of one per window. These are the same rows the renderer used to
 * fetch for itself - the transport moved, the trust level did not: the
 * selection authority still derives leases from transport evidence and never
 * from these bytes (invariant 5), and the authority's own fleet port still
 * projects ids only.
 *
 * `identityKey` is the signed-in user id captured when the FETCH STARTED, and
 * it is the whole fence. A renderer compares it against its own auth context
 * and drops a push belonging to another account. The main-process identity
 * GENERATION cannot serve here - it is a per-process counter with no meaning
 * in a renderer - so the account is named by the one key both sides can
 * compare, which is exactly the key `HostDirectoryService`'s injected
 * `authContextId()` already answers with. `null` means the fetch ran
 * signed-out.
 */
export interface RegisteredHostsPush {
  readonly identityKey: string | null;
  readonly response: HostListResponse;
}
export type {
  ListUserSessionsFetchResult,
  MintHostCredentialFetchResult,
  RetainedStepUpVerifyFetchResult,
  RevokeAllSessionsFetchResult,
  RevokeUserSessionFetchResult,
  StepUpChallengeFetchResult,
} from "@traycer-clients/shared/auth/devices-sessions-fetcher";
export type { MintHostCredentialRequest } from "@traycer/protocol/auth/devices-sessions";
export type {
  UpdateHostVersionPolicyFetchResult,
  UpdateHostVersionPolicyInput,
} from "@traycer-clients/shared/host-client/host-version-policy-fetcher";
export type { DeregisterHostFetchResult } from "@traycer-clients/shared/host-client/host-deregister-fetcher";
