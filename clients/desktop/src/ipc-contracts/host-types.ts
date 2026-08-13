/**
 * Plain-data mirror of `LocalHostSnapshot` from
 * `@traycer-clients/shared/platform/runner-host`. The Electron bridge must not
 * import the shared module directly (Electron main/preload are CommonJS and
 * live outside the shared package's module resolution) - we duplicate the
 * shape here so `contextBridge` serializes a plain object while the renderer
 * consumes the fully typed shared interface.
 */
import type { LiveHostAvailability } from "@traycer-clients/shared/host-client/host-directory";

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
