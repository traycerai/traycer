import type {
  HostTokenMintOutcome,
  HostTokenRenewal,
} from "@traycer-clients/shared/auth/host-token-source";
import type { HostToken } from "@traycer-clients/shared/auth/host-token-store";

/** One host token as main announces it; `token: null` once it is gone. */
export interface HostTokenBridgeChange {
  readonly userId: string;
  readonly hostId: string;
  readonly token: HostToken | null;
}

/**
 * The renderer's reach into main's host-only tokens. Main mints with the
 * sign-in token it already holds, so nothing here carries one.
 */
export interface HostTokensBridgeSurface {
  obtain(
    userId: string,
    hostId: string,
    fresh: boolean,
  ): Promise<HostTokenMintOutcome>;
  renew(userId: string, hostIds: readonly string[]): Promise<HostTokenRenewal>;
  adopt(userId: string, hostId: string, token: HostToken): Promise<void>;
  forgetUser(userId: string): Promise<void>;
  subscribe(handler: (change: HostTokenBridgeChange) => void): {
    dispose(): void;
  };
}
