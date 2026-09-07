/** The Electron bridge must not import the shared module directly (Electron main/preload are CommonJS and live outside the shared package's module resolution). */
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

export interface DesktopPublishedHostSnapshot extends DesktopLocalHostSnapshot {
  readonly availability: LiveHostAvailability;
}

export interface DesktopTrayEpic {
  readonly epicId: string;
  readonly title: string;
  readonly subtitle: string;
}

export type DesktopTrayIndicatorState = "idle" | "active" | "attention";

export type { HostListFetchResult } from "@traycer-clients/shared/host-client/remote-fetcher";

/**
 * These are the same rows the renderer used to fetch for itself.
 * The main-process identity GENERATION cannot serve here - it is a per-process counter with no meaning in a renderer.
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
