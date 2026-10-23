import type { DetailsSubject } from "@/lib/settings-details-entry";

export const settingsDetailsQueryKeys = {
  entry: (
    hostId: string | null,
    subject: DetailsSubject,
    viewerUserId: string,
  ) => ["settings-details", hostId, subject, viewerUserId] as const,
  export: (subject: DetailsSubject) =>
    ["settings-details-export", subject] as const,
};

export const settingsDetailsMutationKeys = {
  secretDestroy: () => ["environment.secrets.destroy"] as const,
  secretUndo: () => ["environment.secrets.undo"] as const,
  secretVerify: () => ["environment.secrets.verify"] as const,
};
