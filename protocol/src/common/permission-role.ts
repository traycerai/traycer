import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

/**
 * The view-only role, and the one place a decoded role becomes access.
 *
 * A person who can open a task can edit it. `viewer` is no longer offered by
 * any role selection, but it stays in the decodable vocabulary
 * (`permission-role`, documented there): stored grants and released peers
 * still carry it, and it is never rewritten. It gives the access of `editor`
 * - the owner's ruling of 19 Nov 2026, "It can stay as viewer but treated as
 * editor on new versions". This module is the boundary between the two
 * vocabularies, and it is deliberately the only one: a reader that reaches for
 * the decoded value directly is a reader that can mistake `viewer` for
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
 * A decoded role as access: `viewer` is `editor`, and an unknown role and no
 * grant at all are both `null`, which every caller already reads as no access.
 *
 * `null` is not "read-only". There is no read-only role to return, which is
 * the point of routing every decode through here: `viewer` gives an editor's
 * access, and a value nothing recognises - one a newer writer invents - gives
 * none.
 */
export function grantedRole(role: string | null): GrantedPermissionRole | null {
  switch (role) {
    case "owner":
      return "owner";
    case "editor":
    case "viewer":
      return "editor";
    default:
      return null;
  }
}
