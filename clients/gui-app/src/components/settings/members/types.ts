/**
 * View models for Settings ▸ Members. Field names follow
 * `environment.members@1.1` and the remove-preview answer so a later hook
 * can pass the wire through unchanged.
 */

export type TeamRole = "admin" | "editor" | "viewer";

/** `null` is an accepted member on a host that has not yet filled inviteState. */
export type MemberInviteState = "accepted" | "pending" | null;

export type MemberRemovalState = "none" | "pending" | "done";

export type MembersInviteOutcome =
  | { readonly outcome: "sent"; readonly seatDelta: SeatDelta | null }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "seat_limit" };

export type MembersSetRoleOutcome =
  | { readonly outcome: "changed" }
  | { readonly outcome: "last_admin" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "plan_required" };

export type MembersRemoveOutcome =
  | { readonly outcome: "revoked" }
  | { readonly outcome: "pending"; readonly receiptId: string }
  | { readonly outcome: "last_admin" }
  | { readonly outcome: "forbidden" }
  | { readonly outcome: "plan_required" };

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

export interface RemovePreviewModel {
  readonly memberName: string;
  readonly activeTurns: number | null;
  readonly terminals: number | null;
  readonly hostName: string | null;
  readonly sharedSignIns: readonly string[];
  readonly paidSandboxes: readonly PaidSandboxPreview[];
  readonly linkedPlan: string | null;
}

export interface PlanUnlinkPreviewModel {
  readonly memberName: string;
  readonly planLabel: string;
  readonly turnsOnPlan: number;
  readonly whatKeepsWorking: string;
}

/**
 * P3's drawer subject. Members rows use kind `member` and key = userId;
 * the legacy notice / page uses kind `member` and an empty key.
 */
export interface MembersDetailsSubject {
  readonly environmentId: string;
  readonly kind: "member";
  readonly key: string;
}

export function isTeamRole(value: string): value is TeamRole {
  return value === "admin" || value === "editor" || value === "viewer";
}
