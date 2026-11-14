import {
  createContext,
  useContext,
  useCallback,
  useSyncExternalStore,
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { EnvironmentProfileRecords } from "@traycer-clients/shared/host-client/profile-record-actions";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useRereadConfigurationOnFocus } from "@/hooks/environment/use-reread-configuration-on-focus";
import { useAuthService } from "@/lib/host";
import { authQueryKeys } from "@/lib/query-keys";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useConfigurationSource } from "./configuration-source";

export interface TeamProviderRecords {
  readonly providers: EnvironmentProfileRecords["providers"];
  readonly readPending: boolean;
  readonly readFailed: boolean;
  readonly reread: () => Promise<EnvironmentProfileRecords["providers"] | null>;
}

export const TeamProviderRecordsContext =
  createContext<TeamProviderRecords | null>(null);

export function useTeamProviderRecords(): TeamProviderRecords | null {
  return useContext(TeamProviderRecordsContext);
}

/** Every team row comes from the app's session, including on a team's own computer. */
export function useTeamProviderRecordsRead(): TeamProviderRecords | null {
  const source = useConfigurationSource();
  const environmentId =
    source.kind === "pool" && source.configuration === "team"
      ? source.environmentId
      : null;
  const auth = useAuthService();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const attended = useSyncExternalStore(
    subscribeAttention,
    windowAttended,
    windowAttended,
  );
  useRereadConfigurationOnFocus(environmentId);
  const list = useQuery({
    queryKey: authQueryKeys.environmentProfileRecords(environmentId, viewerId),
    enabled: environmentId !== null && viewerId.length > 0 && authorized,
    queryFn: async ({ signal }): Promise<EnvironmentProfileRecords> => {
      if (environmentId === null)
        throw new Error(PROVIDER_STATE_UNREADABLE_COPY);
      const result = await auth.readProfileRecords(environmentId, signal);
      if (result.kind !== "ok") throw new Error(PROVIDER_STATE_UNREADABLE_COPY);
      return result.list;
    },
    retry: false,
    refetchInterval: attended ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  const refetch = list.refetch;
  const reread = useCallback(async () => {
    const answer = await refetch();
    return answer.isError ? null : (answer.data?.providers ?? null);
  }, [refetch]);
  if (environmentId === null || list.data?.profileSyncEnabled === false)
    return null;
  return {
    providers: list.data?.providers ?? [],
    readPending: list.isPending,
    readFailed: list.isError,
    reread,
  };
}

function windowAttended(): boolean {
  return isDocumentVisible() && document.hasFocus();
}

function subscribeAttention(listener: () => void): () => void {
  const unsubscribe = subscribeDocumentVisibility(listener);
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  return () => {
    unsubscribe();
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
  };
}
