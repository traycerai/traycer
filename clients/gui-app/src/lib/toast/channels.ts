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
