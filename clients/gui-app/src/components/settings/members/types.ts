/**
 * View models for Settings ▸ Members. Field names follow
 * `environment.members@1.1` and the remove-preview answer so a later hook
 * can pass the wire through unchanged.
 */

/**
 * A role a team member HOLDS. The view-only role is retired, so a wire value
 * that still decodes to it is no seat authority at all: resolve one with
 * `grantedTeamMemberRole` and carry the `null` rather than naming a role.
 */
export type TeamRole = "admin" | "editor";

/** `null` is an accepted member on a host that has not yet filled inviteState. */
export type MemberInviteState = "accepted" | "pending" | null;

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
  | { readonly outcome: "removed" }
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
  /** `null` for a row holding no seat authority - see {@link TeamRole}. */
  readonly effectiveRole: TeamRole | null;
  readonly linkedPlan: boolean;
  readonly inviteState: MemberInviteState;
  readonly invitedAddress: string | null;
}

/** A member's running work, as a team computer counted it. */
export interface MemberWorkNow {
  readonly activeTurns: number;
  readonly terminals: number;
  readonly hostName: string | null;
}

/**
 * What the removal confirm shows. The member is named by the row and the
 * dialog, not by a preview.
 */
export interface RemovePreviewModel {
  /** authn's: the team's sandboxes that get a replacement sign-in. */
  readonly sandboxesToRekey: number;
  /** Null until a team computer has counted it, and when none can. */
  readonly workNow: MemberWorkNow | null;
}

/** The removal confirm's read: still being read, read, or refused. */
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
 * The drawer subject. Members rows use kind `member` and key = userId;
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
  return value === "admin" || value === "editor";
}
