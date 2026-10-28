import type { DetailsSubject } from "@/lib/settings-details-entry";

export const settingsDetailsQueryKeys = {
  all: () => ["settings-details"] as const,
  entry: (
    hostId: string | null,
    subject: DetailsSubject,
    viewerUserId: string,
  ) => ["settings-details", hostId, subject, viewerUserId] as const,
  export: (subject: DetailsSubject) =>
    ["settings-details-export", subject] as const,
};

export const settingsDetailsMutationKeys = {
  secretCreate: () => ["environment.secrets.create"] as const,
  secretDestroy: () => ["environment.secrets.destroy"] as const,
  // Details' Retry of a removal: the versions read, then Remove again.
  secretRemovalRetry: () =>
    ["environment.secrets.destroy", "removal-retry"] as const,
  secretReplaceValue: () => ["environment.secrets.replaceValue"] as const,
  secretUndo: () => ["environment.secrets.undo"] as const,
  secretVerify: () => ["environment.secrets.verify"] as const,
  // The Add dialog's Verify, of a value typed but not saved.
  secretVerifyCandidate: () =>
    ["environment.secrets.verify", "candidate"] as const,
};
