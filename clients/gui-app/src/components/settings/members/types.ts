/**
 * View models for Settings ▸ Members. Field names follow
 * `environment.members@1.1` and the remove-preview answer so a later hook
 * can pass the wire through unchanged.
 */

export type TeamRole = "admin" | "editor" | "viewer";

/** `null` is an accepted member on a host that has not yet filled inviteState. */
export type MemberInviteState = "accepted" | "pending" | null;

export type MemberRemovalState = "none" | "pending";

/**
 * `failed` is this client's own: the request got no answer (it was refused
 * unsent, or the connection failed), so nothing about the team is known.
 */
export type MembersInviteOutcome =
  | { readonly outcome: "sent"; readonly seatDelta: SeatDelta | null }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "seat_limit" }
  | { readonly outcome: "failed" };

export type MembersSetRoleOutcome =
  | { readonly outcome: "changed" }
  | { readonly outcome: "last_admin" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "plan_required" }
  | { readonly outcome: "failed" };

export type MembersRemoveOutcome =
  | { readonly outcome: "revoked" }
  | { readonly outcome: "pending"; readonly receiptId: string }
  | { readonly outcome: "last_admin" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "plan_required" }
  | { readonly outcome: "failed" };

export interface SeatDelta {
  readonly used: number;
  readonly total: number;
}

export interface MembersListMember {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly effectiveRole: TeamRole;
  readonly linkedPlan: boolean;
  readonly inviteState: MemberInviteState;
  readonly invitedAddress: string | null;
  readonly removalState: MemberRemovalState;
}

export interface PaidSandboxPreview {
  readonly name: string;
  readonly startedBy: string;
}

/** The member named by a row and its dialogs, not by a preview. */
export interface RemovePreviewModel {
  readonly activeTurns: number | null;
  readonly terminals: number | null;
  readonly hostName: string | null;
  readonly sharedSignIns: readonly string[];
  readonly paidSandboxes: readonly PaidSandboxPreview[];
  readonly linkedPlan: string | null;
}

/** `turnsOnPlan` null: the serving host cannot see the member's turns. */
export interface PlanUnlinkPreviewModel {
  readonly planLabel: string;
  readonly turnsOnPlan: number | null;
  readonly whatKeepsWorking: string;
}

/** A dialog's preview: still being read, read, or refused. */
export type PreviewState<Preview> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: Preview }
  | { readonly status: "failed" };

/**
 * The members read: a failed read, or a host that does not serve it
 * (`unsupported`), is never shown as an empty team.
 */
export type MembersReadState = "loading" | "failed" | "unsupported" | "ready";

/**
 * P3's drawer subject. Members rows use kind `member` and key = userId;
 * the legacy notice / page uses kind `member` and an empty key.
 *
 * `roleLabel` is the role the row holds, which the drawer cannot read for
 * itself: a member's role is committed inside the item's value and
 * `environment.history` ships no values. `null` for the page's own subject,
 * which names no member.
 */
export interface MembersDetailsSubject {
  readonly environmentId: string;
  readonly kind: "member";
  readonly key: string;
  readonly roleLabel: string | null;
}

export function isTeamRole(value: string): value is TeamRole {
  return value === "admin" || value === "editor" || value === "viewer";
}
