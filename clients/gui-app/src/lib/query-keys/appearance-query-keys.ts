import { hostQueryKeys } from "./host-query-keys";

export const appearanceQueryKeys = {
  fallbackScope: (accountId: string | null, hostId: string | null) =>
    ["appearance-fallback", accountId, hostId] as const,
  fallback: (
    accountId: string | null,
    hostId: string | null,
    workspacePath: string | null,
  ) =>
    [
      ...appearanceQueryKeys.fallbackScope(accountId, hostId),
      workspacePath,
    ] as const,
  source: (accountId: string, hostId: string, source: string) =>
    [
      ...hostQueryKeys.scope(hostId),
      "appearance-source",
      accountId,
      source,
    ] as const,
  blob: (scopeKey: string, identity: string | null) =>
    ["appearance-blob", scopeKey, identity] as const,
};
