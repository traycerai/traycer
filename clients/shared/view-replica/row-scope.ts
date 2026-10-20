import { z } from "zod";

/**
 * The scope whose authority put one cached row on the device.
 *
 * - `account` - the viewer's own authority: their own records, and anything
 *   granted to them by name or by link.
 * - `organization` - a team's (an authn organization's) authority: the row is
 *   on the page because the viewer belongs to that team.
 *
 * Withdrawing a scope removes exactly the rows it authorized. A task shared
 * with the viewer by name stays when they leave the team that also sees it,
 * because its row names `account`, not the team.
 */
export type ViewReplicaRowScope =
  | { readonly kind: "account" }
  | { readonly kind: "organization"; readonly id: string };

export const viewReplicaRowScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account") }),
  z.object({ kind: z.literal("organization"), id: z.string().min(1) }),
]);

export const ACCOUNT_ROW_SCOPE: ViewReplicaRowScope = Object.freeze({
  kind: "account",
});

export function organizationRowScope(id: string): ViewReplicaRowScope {
  return { kind: "organization", id };
}

export function sameRowScope(
  left: ViewReplicaRowScope,
  right: ViewReplicaRowScope,
): boolean {
  if (left.kind === "account" || right.kind === "account") {
    return left.kind === right.kind;
  }
  return left.id === right.id;
}
