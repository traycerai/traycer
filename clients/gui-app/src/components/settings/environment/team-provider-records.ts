import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EnvironmentProfileRecords } from "@traycer-clients/shared/host-client/profile-record-actions";
import {
  cloudProviderRecordsQuery,
  useCloudProviderKeyScope,
} from "@/hooks/providers/use-cloud-provider-api-key-query";
import { useRereadConfigurationOnFocus } from "@/hooks/environment/use-reread-configuration-on-focus";
import { useAuthService } from "@/lib/host";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { cloudProviderKeyKeys } from "@/lib/query-keys/cloud-provider-key-keys";
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

/** One press reads the existing query and keeps that answer for this dialog. */
export function useTeamProviderSignInRead(
  environmentId: string,
  enabled: boolean,
) {
  const records = useTeamProviderRecords();
  const queries = useQueryClient();
  const scope = useCloudProviderKeyScope();
  const queryKey = cloudProviderKeyKeys.records(
    scope.viewerId,
    scope.identityGeneration,
    environmentId,
  );
  const read = useMutation({
    mutationKey: queryKey,
    retry: false,
    mutationFn: async (): Promise<EnvironmentProfileRecords | null> => {
      if (records === null) return null;
      try {
        if ((await records.reread()) === null) return null;
        return (
          queries.getQueryData<EnvironmentProfileRecords>(queryKey) ?? null
        );
      } catch {
        return null;
      }
    },
  });
  const requested = useRef(false);
  const reread = read.mutate;
  useEffect(() => {
    if (!enabled || requested.current) return;
    requested.current = true;
    reread();
  }, [enabled, reread]);
  return read;
}

/** Every team row comes from the app's session, including on a team's own computer. */
export function useTeamProviderRecordsRead(): TeamProviderRecords | null {
  const source = useConfigurationSource();
  const environmentId =
    source.kind === "pool" && source.configuration === "team"
      ? source.environmentId
      : null;
  const auth = useAuthService();
  const scope = useCloudProviderKeyScope();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const attended = useSyncExternalStore(
    subscribeAttention,
    windowAttended,
    windowAttended,
  );
  useRereadConfigurationOnFocus(environmentId);
  const shared = cloudProviderRecordsQuery(auth, scope, authorized);
  const list = useQuery({
    ...shared,
    enabled: environmentId !== null && shared.enabled === true,
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
