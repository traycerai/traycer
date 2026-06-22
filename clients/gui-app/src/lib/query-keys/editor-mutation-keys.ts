export const editorMutationKeys = {
  openPaths: () => ["editor.openPaths"] as const,
};

export const editorQueryKeys = {
  availability: (runnerHostScope: string) =>
    ["editor", "availability", runnerHostScope] as const,
};
