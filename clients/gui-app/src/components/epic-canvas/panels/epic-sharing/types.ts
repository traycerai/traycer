import type {
  EpicCollaboratorView,
  EpicTeamCollaboratorView,
} from "@/hooks/epics/use-epic-collaborators-query";
import type { PermissionRole } from "@/lib/epic-collaborator-roles";

export type RevokeTarget =
  | {
      readonly kind: "user";
      readonly collaborator: EpicCollaboratorView;
    }
  | {
      readonly kind: "team";
      readonly team: EpicTeamCollaboratorView;
    };

export type TeamRow =
  | {
      readonly kind: "shared";
      readonly key: string;
      readonly teamId: string;
      readonly name: string;
      readonly avatarUrl: string | null;
      readonly role: PermissionRole;
      readonly members: ReadonlyArray<EpicCollaboratorView>;
    }
  | {
      readonly kind: "unshared";
      readonly key: string;
      readonly teamId: string;
      readonly name: string;
      readonly avatarUrl: string | null;
    };

/**
 * `unauthorized` is NOT a flavour of `ready`, and that is the whole reason it
 * exists as a fourth member rather than being folded into the empty case.
 *
 * `epic.listCollaborators` is a cloud read, so an unverified session never
 * dispatches it - the query is disabled, `data` stays `undefined`, and every
 * derived count is zero. Collapsed into `ready`, that renders "No direct
 * collaborators yet." over an epic that may be shared with a dozen people:
 * a definite claim about access, manufactured from a question nobody asked.
 */
export type SharingAccessLoadState =
  | "loading"
  | "error"
  | "ready"
  | "unauthorized";
export type SharingAccessPermission = "owner" | "read_only";

export interface TeamPendingState {
  readonly anyMutation: boolean;
  readonly shareTeamId: string | null;
  readonly roleTeamId: string | null;
  readonly revokeTeamId: string | null;
}

export type SharingPendingAction =
  | { readonly kind: "role-user"; readonly userId: string }
  | { readonly kind: "role-team"; readonly teamId: string }
  | { readonly kind: "share-team"; readonly teamId: string }
  | { readonly kind: "revoke-user"; readonly userId: string }
  | { readonly kind: "revoke-team"; readonly teamId: string };

export interface RevokeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly isPending: boolean;
  readonly onConfirm: () => void;
}
