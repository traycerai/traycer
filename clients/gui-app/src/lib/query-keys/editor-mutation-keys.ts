export const editorMutationKeys = {
  openPaths: () => ["editor.openPaths"] as const,
};

export const editorQueryKeys = {
  /** Prefix of every runner host's install probe, for invalidating them all. */
  availabilityAll: () => ["editor", "availability"] as const,
  availability: (runnerHostScope: string) =>
    ["editor", "availability", runnerHostScope] as const,
};
