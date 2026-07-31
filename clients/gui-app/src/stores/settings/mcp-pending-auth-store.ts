import { create } from "zustand";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";

/**
 * Navigate-safe MCP OAuth pending-auth store.
 *
 * Key matches the host registry tuple from R02:
 * `(providerId, scope, workspaceRoot, serverName)`.
 * Re-issuing awaitLogin/cancelLogin with the same tuple resumes the same
 * host-side attempt after a settings navigation.
 */
export type McpPendingAuthKey = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly serverName: string;
};

export type McpPendingAuthEntry = {
  readonly key: McpPendingAuthKey;
  readonly hostId: string;
  readonly startedAt: number;
  readonly authorizationUrl: string | null;
  readonly instruction: string | null;
};

function keyString(key: McpPendingAuthKey): string {
  return [
    key.providerId,
    key.scope,
    key.workspaceRoot ?? "",
    key.serverName,
  ].join("\0");
}

interface McpPendingAuthStore {
  readonly entries: Readonly<Record<string, McpPendingAuthEntry>>;
  readonly upsert: (entry: McpPendingAuthEntry) => void;
  readonly remove: (key: McpPendingAuthKey) => void;
  readonly get: (key: McpPendingAuthKey) => McpPendingAuthEntry | null;
  readonly listForHost: (hostId: string) => readonly McpPendingAuthEntry[];
}

export const useMcpPendingAuthStore = create<McpPendingAuthStore>()(
  (set, get) => ({
    entries: {},
    upsert: (entry) => {
      const id = keyString(entry.key);
      set((state) => ({
        entries: { ...state.entries, [id]: entry },
      }));
    },
    remove: (key) => {
      const id = keyString(key);
      set((state) => {
        if (!(id in state.entries)) return state;
        const next = { ...state.entries };
        delete next[id];
        return { entries: next };
      });
    },
    get: (key) => get().entries[keyString(key)] ?? null,
    listForHost: (hostId) =>
      Object.values(get().entries).filter((e) => e.hostId === hostId),
  }),
);

export function mcpPendingAuthKeyString(key: McpPendingAuthKey): string {
  return keyString(key);
}
