export const terminalMutationKeys = {
  create: () => ["terminal.create"] as const,
  kill: () => ["terminal.kill"] as const,
  rename: () => ["terminal.rename"] as const,
  plainCreate: (hostId: string) => ["terminal.plain.create", hostId] as const,
  plainEnsureRunning: (hostId: string) =>
    ["terminal.plain.ensureRunning", hostId] as const,
  plainRename: (hostId: string) => ["terminal.plain.rename", hostId] as const,
  plainClose: (hostId: string) => ["terminal.plain.close", hostId] as const,
  plainImportLegacy: (hostId: string) =>
    ["terminal.plain.importLegacy", hostId] as const,
};
