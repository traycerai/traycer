export const commandAllowlistMutationKeys = {
  remove: () => ["commandAllowlist.remove"] as const,
  clear: () => ["commandAllowlist.clear"] as const,
};
