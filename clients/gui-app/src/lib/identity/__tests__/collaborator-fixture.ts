import type { CollaboratorEntry } from "@traycer/protocol/host/epic/unary-schemas";

/** A direct collaborator as `epic.listCollaborators` puts them on the wire. */
export function collaboratorEntry(
  userId: string,
  profile: {
    readonly displayName: string;
    readonly avatarUrl: string;
  } | null,
): CollaboratorEntry {
  return {
    role: "editor",
    accessType: "direct",
    environmentId: null,
    grantedAt: 1,
    grantedBy: "owner",
    user: {
      userId,
      profile: profile === null ? null : { ...profile, email: "", handle: "" },
    },
    team: null,
  };
}
