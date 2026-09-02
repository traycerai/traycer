import { scopedToastChannel } from "@/lib/toast/toast-channel";

/**
 * Central registry of replacement-semantics toast channels. One place to see
 * every "this supersedes its prior state" toast id, and the single source of
 * truth for their prefixes. Add a new channel here rather than hand-rolling an
 * id string at the call site, so two emitters of the same thing can't drift
 * onto different ids and stack.
 *
 * Scope each entity-keyed channel by the id of the thing it describes (epic id,
 * host id, ...). Different entities stay independent; repeated signals for
 * the SAME entity replace in place.
 */

/**
 * Permission-role transitions for one epic. Upgrade and downgrade collapse onto
 * one id so a rapid up-then-down (or repeated change) shows only the latest
 * role rather than a growing stack.
 */
export const epicRoleToast = scopedToastChannel("epic-role");

/**
 * Terminal "this epic is gone" notice for one epic (deleted / revoked /
 * unavailable-on-open). Keyed by epic so a duplicate signal for the same epic
 * replaces rather than piling a second eject toast.
 */
export const epicAccessToast = scopedToastChannel("epic-access");

/**
 * Stored-session rehydration failure. This is a global auth-state notice, so
 * repeated session-expired signals replace the prior toast instead of leaving
 * persistent inline sign-in copy behind.
 */
export const authSessionExpiredToast =
  scopedToastChannel("auth-session")("expired");

/**
 * A link-login QR opened while this phone is already signed in. Repeated scans
 * replace rather than stack: the answer is the same every time, and the second
 * one is usually the user scanning again because the first appeared to do
 * nothing.
 */
export const linkLoginAlreadySignedInToast =
  scopedToastChannel("link-login")("already-signed-in");

/**
 * A host this client refused because its published Noise static key no longer
 * matches the one pinned on first sight (browser-security-hardening H11), and
 * a certificate a server presented that this machine does not trust. Both are
 * per-entity: repeated refusals of the same host or the same server say the
 * same thing, and the recovery is one decision, not a growing stack.
 */
export const hostKeyPinMismatchToast = scopedToastChannel("host-key-pin");
export const untrustedCertificateToast = scopedToastChannel("cert-untrusted");

/**
 * Main refused a cross-window auth-session projection this window pushed
 * (`WindowsBridgeAuthSessionBridge`) - the bearer failed verification, so the
 * sibling window's session did not adopt it. Global, not entity-scoped: a
 * repeat refusal says the same thing, so it replaces rather than stacking.
 */
export const authSessionRefusedToast =
  scopedToastChannel("auth-session")("refused");
