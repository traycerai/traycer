import type {
  HostTokenMintOutcome,
  HostTokenRenewal,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostToken } from "@traycer-clients/shared/auth/host-token-store";

/**
 * One host token as main announces it; `token: null` once it is gone. `era`
 * is main's era for that person when it was announced.
 */
export interface HostTokenBridgeChange {
  readonly userId: string;
  readonly hostId: string;
  readonly token: HostToken | null;
  readonly era: number;
}

/** Main's era for the person once the work it was asked for had run. */
export interface HostTokenEraReply {
  readonly era: number;
}

export interface HostTokenObtainReply extends HostTokenEraReply {
  readonly outcome: HostTokenMintOutcome;
}

export interface HostTokenRenewReply extends HostTokenEraReply {
  readonly renewal: HostTokenRenewal;
}

/**
 * The era the preload reports when main gives none (an unknown or untrusted
 * sender). Main never issues it, so any work that names it is refused.
 */
export const NO_ISSUED_HOST_TOKEN_ERA = -1;

/**
 * The renderer's reach into main's host-only tokens. Main mints with the
 * sign-in token it already holds, so nothing here carries one.
 *
 * Main's era is the only one. `era` reads it, synchronously. Every request
 * names the era its work began in, and main keeps nothing for a request whose
 * era has moved.
 */
export interface HostTokensBridgeSurface {
  era(userId: string): number;
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
    expectedEra: number,
  ): Promise<HostTokenObtainReply>;
  renew(
    userId: string,
    hostIds: readonly string[],
    expectedEra: number,
  ): Promise<HostTokenRenewReply>;
  adopt(
    userId: string,
    hostId: string,
    token: HostToken,
    expectedEra: number,
  ): Promise<HostTokenEraReply>;
  forgetUser(userId: string): Promise<HostTokenEraReply>;
  subscribe(handler: (change: HostTokenBridgeChange) => void): {
    dispose(): void;
  };
}
