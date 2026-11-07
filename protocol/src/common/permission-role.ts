import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The retired view-only role, and the one place a decoded role becomes access.
 *
 * A person who can open a task can edit it. `viewer` is retired from every
 * grant, role selection and authorization; it survives in the decodable
 * vocabulary only (`permission-role`, documented there), so that legacy data
 * and released peers keep parsing. This module is the boundary between the two
 * vocabularies, and it is deliberately the only one: a reader that reaches for
 * the decoded value directly is a reader that can mistake a retired role for
 * read-only access.
 */

/**
 * The roles a grant may name - what the rest of the tree means by a role.
 *
 * Kept as its own enum rather than derived from the decodable vocabulary by
 * `.exclude()`: this list is the contract, and a conformance test asserts it
 * stays a subset of what decodes, so neither can drift into granting a role
 * the other cannot read.
 */
export const grantedPermissionRoleSchema = lazySchema(() =>
  z.enum(["owner", "editor"]),
);
export type GrantedPermissionRole = z.infer<typeof grantedPermissionRoleSchema>;

/**
 * A decoded role as access: the retired role, an unknown role and no grant at
 * all are all `null`, which every caller already reads as no access.
 *
 * `null` is not "read-only". There is no read-only role left to return, which
 * is the point of routing every decode through here: a retired grant yields
 * nothing, and it can never be widened by a reader that forgot about it.
 */
export function grantedRole(role: string | null): GrantedPermissionRole | null {
  switch (role) {
    case "owner":
      return "owner";
    case "editor":
      return "editor";
    default:
      return null;
  }
}
