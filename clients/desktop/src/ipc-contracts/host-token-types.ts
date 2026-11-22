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
  /** The token main's write replaced (`null`: none, or a removal). */
  readonly replaced: string | null;
}

/** Main's era for the person once the work it was asked for had run. */
export interface HostTokenEraReply {
  readonly era: number;
}

/** The host process a window's ask or adoption is for, as that window observed it. */
export interface HostTokenObtainOwner {
  readonly observed: string | null;
}

export interface HostTokenObtainReply extends HostTokenEraReply {
  readonly outcome: HostTokenMintOutcome;
  /** The outcome's token is the one main holds for the pair as it replies. */
  readonly held: boolean;
}

export interface HostTokenAdoptReply extends HostTokenEraReply {
  /** Main wrote the adopted token. */
  readonly kept: boolean;
}

export interface HostTokenRenewReply extends HostTokenEraReply {
  readonly renewal: HostTokenRenewal;
}

/**
 * The tokens main holds for the person signed in there, with main's era for
 * them, read in one step; `userId: null` and no tokens while no one is.
 */
export interface HostTokenSnapshotReply {
  readonly userId: string | null;
  readonly era: number;
  readonly tokens: readonly {
    readonly hostId: string;
    readonly token: HostToken;
  }[];
}

/**
 * The era the preload reports when main gives none (an unknown or untrusted
 * sender). Main never issues it, so any work that names it is refused.
 */
export const NO_ISSUED_HOST_TOKEN_ERA = -1;

/**
 * Main mints with the sign-in it holds, so nothing here carries one. Every request
 * names the era its work began in; main keeps nothing for one whose era has moved.
 */
export interface HostTokensBridgeSurface {
  era(userId: string): number;
  /**
   * `owner` is the host process the window asks for, as the window observes it
   * (`null`: none): main never joins asks for two different observed processes.
   */
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
    expectedEra: number,
    owner: HostTokenObtainOwner | null,
  ): Promise<HostTokenObtainReply>;
  renew(
    userId: string,
    hostIds: readonly string[],
    expectedEra: number,
  ): Promise<HostTokenRenewReply>;
  /**
   * `owner` is the host process the window holds the token for: main writes
   * it only while that is still the process main observes for the host id.
   */
  adopt(
    userId: string,
    hostId: string,
    token: HostToken,
    expectedEra: number,
    owner: HostTokenObtainOwner,
  ): Promise<HostTokenAdoptReply>;
  forgetUser(userId: string): Promise<HostTokenEraReply>;
  snapshot(): Promise<HostTokenSnapshotReply>;
  subscribe(handler: (change: HostTokenBridgeChange) => void): {
    dispose(): void;
  };
}
