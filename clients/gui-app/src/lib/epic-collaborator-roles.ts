import {
  grantedPermissionRoleSchema,
  type GrantedPermissionRole,
} from "@traycer/protocol/common/permission-role";
import { type PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";

export type { PermissionRole };

/**
 * The roles the sharing panel may assign: every role a grant can name except
 * `owner`, which is never handed out from here.
 *
 * The view-only role is retired, so this is now a single role. The list stays
 * derived rather than written out as `["editor"]`, because every control that
 * offers a role reads it, and {@link roleChangeHasTarget} is what decides
 * whether offering one is a choice at all.
 */
export const ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA =
  grantedPermissionRoleSchema.exclude(["owner"]);

export type AssignableCollaboratorRole =
  (typeof ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA.options)[number];

export const ASSIGNABLE_COLLABORATOR_ROLES =
  ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA.options satisfies ReadonlyArray<AssignableCollaboratorRole>;

/** The role every new invite and every new team share carries. */
export const DEFAULT_COLLABORATOR_ROLE: AssignableCollaboratorRole = "editor";

/**
 * Whether changing `role` has anywhere to go.
 *
 * `false` for a row already holding the only assignable role: there is no
 * second role to move it to, so the row shows what it is instead of offering a
 * choice of one. An owner row still answers `true` - demoting an owner to
 * editor is a real change.
 */
export function roleChangeHasTarget(role: PermissionRole): boolean {
  return ASSIGNABLE_COLLABORATOR_ROLES.some((option) => option !== role);
}

export const EPIC_COLLABORATOR_ROLE_LABELS: Readonly<
  Record<GrantedPermissionRole, string>
> = {
  owner: "Owner",
  editor: "Editor",
};
