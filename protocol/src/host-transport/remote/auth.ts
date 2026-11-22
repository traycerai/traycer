import type { FatalErrorDetails } from "../../framework/ws-protocol";
import type { ReservedAuthzSlot, SessionOpenPayload } from "../mux";
import type { AttachGrant } from "./grant";

export type RemoteSessionAuthRecoveryOutcome =
  | "rotated"
  | "rejected"
  | "network-error"
  /**
   * The bearer was not rotated because the local plane retained its identity
   * on its own terms; treated as terminal for this session like `rejected`.
   * Mirrors the client's `RevalidateOutcome`.
   */
  | "local-plane-retained";

/** Authentication fields placed inside the encrypted session-open frame. */
export interface RemoteSessionOpenAuth {
  readonly bearer: SessionOpenPayload["bearer"];
  readonly authz: ReservedAuthzSlot;
  /** Stable comparison key used to bound no-progress UNAUTHORIZED retries. */
  readonly fingerprint: string;
}

/** What every session's credential plane answers, whatever its peer. */
interface SessionCredentialPlane {
  /** Stable diagnostic cause used when no open-frame credentials are ready. */
  readonly missingOpenAuthCause: string;
  readonly readCredentialUpdateBearer: () => string | null;
  readonly currentFingerprint: () => string | null;
  /** Called with the host's own `UNAUTHORIZED` refusal that this recovers from. */
  readonly revalidateForReconnect:
    | ((
        refusal: FatalErrorDetails,
      ) => Promise<RemoteSessionAuthRecoveryOutcome>)
    | null;
  /** A relay's session kill is not the host's refusal and is never reported. */
  readonly door?: SessionDoorObserver;
}

export interface SessionDoorObserver {
  readonly refused: (details: FatalErrorDetails) => void;
  /**
   * The host admitted this session's open. The session calls the answer once,
   * when that connection ends: lost, closed, or ended by a fatal, before it
   * reports the fatal that ended it.
   */
  readonly admitted: () => () => void;
}

/**
 * Authentication plug for a relay client session.
 *
 * A client presents its host-only token through the reserved `authz` slot, and a
 * host-side dialer a grant. The attach grant is supplied because host-principal
 * deployments may deliberately reuse it as the in-channel proof.
 */
export interface RemoteSessionAuth extends SessionCredentialPlane {
  readonly readOpenAuth: (
    attachGrant: AttachGrant,
  ) => RemoteSessionOpenAuth | null;
}

/** The bearer a pool session presents on `open`. */
export interface PoolSessionOpenAuth {
  readonly bearer: SessionOpenPayload["bearer"];
  /** Stable comparison key used to bound no-progress UNAUTHORIZED retries. */
  readonly fingerprint: string;
}

/**
 * Authentication plug for a session to the server pool.
 *
 * It has no `authz` to give, by construction: the reserved slot carries a
 * host-only token or grant, and the pool is trusted
 * infrastructure whose authority IS the viewer's bearer. A pool `open` always
 * writes `authz: null`.
 */
export interface PoolSessionAuth extends SessionCredentialPlane {
  readonly readOpenAuth: () => PoolSessionOpenAuth | null;
}
