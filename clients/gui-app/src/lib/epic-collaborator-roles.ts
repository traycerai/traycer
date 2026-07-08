import {
  LatestPermissionRoleSchema,
  type PermissionRole,
} from "@traycer/protocol/host/epic/unary-schemas";

export type { PermissionRole };

export const ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA =
  LatestPermissionRoleSchema.exclude(["owner"]);

export type AssignableCollaboratorRole =
  (typeof ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA.options)[number];

export const ASSIGNABLE_COLLABORATOR_ROLES =
  ASSIGNABLE_COLLABORATOR_ROLE_SCHEMA.options satisfies ReadonlyArray<AssignableCollaboratorRole>;

export const EPIC_COLLABORATOR_ROLE_LABELS: Readonly<
  Record<PermissionRole, string>
> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};
