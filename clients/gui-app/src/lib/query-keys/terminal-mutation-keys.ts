export const terminalMutationKeys = {
  create: () => ["terminal.create"] as const,
  kill: () => ["terminal.kill"] as const,
  rename: () => ["terminal.rename"] as const,
};
