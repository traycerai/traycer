import type { ReservedAuthzSlot, SessionOpenPayload } from "../mux";
import type { AttachGrant } from "./grant";

export type RemoteSessionAuthRecoveryOutcome =
  "rotated" | "rejected" | "network-error";

/** Authentication fields placed inside the encrypted session-open frame. */
export interface RemoteSessionOpenAuth {
  readonly bearer: SessionOpenPayload["bearer"];
  readonly authz: ReservedAuthzSlot;
  /** Stable comparison key used to bound no-progress UNAUTHORIZED retries. */
  readonly fingerprint: string;
}

/**
 * Authentication plug for a relay client session.
 *
 * Browser clients can present their user bearer with `authz: null`; a host-side
 * dialer can instead present a grant through the reserved `authz` slot without
 * importing any client bearer machinery. The attach grant is supplied because
 * host-principal deployments may deliberately reuse it as the in-channel proof.
 */
export interface RemoteSessionAuth {
  /** Stable diagnostic cause used when no open-frame credentials are ready. */
  readonly missingOpenAuthCause: string;
  readonly readOpenAuth: (
    attachGrant: AttachGrant,
  ) => RemoteSessionOpenAuth | null;
  readonly readCredentialUpdateBearer: () => string | null;
  readonly currentFingerprint: () => string | null;
  readonly revalidateForReconnect:
    (() => Promise<RemoteSessionAuthRecoveryOutcome>) | null;
}
