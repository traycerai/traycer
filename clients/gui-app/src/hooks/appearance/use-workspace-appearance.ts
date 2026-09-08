import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  WorkspaceAppearanceRead,
  WorkspaceSetAppearanceRequest,
} from "@traycer/protocol/host/workspace/appearance-schemas";
import {
  useHostQueryWithResponseMap,
  useHostMutation,
} from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { hostQueryKeys, workspaceMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { appearanceQueryKeys } from "@/lib/query-keys/appearance-query-keys";
import {
  type AppearanceScope,
  captureAppearanceSession,
  isAppearanceSessionCurrent,
  readAppearanceSnapshot,
  readAppearanceSource,
  writeAppearanceSnapshot,
  writeAppearanceSource,
  writeAppearanceBlob,
} from "@/lib/appearance/appearance-cache";
import { mergeAppearanceRead } from "@/lib/appearance/resolve-appearance";
import { resolvePrimaryPath } from "@/lib/worktree/resolve-primary-path";
import { isEpicCreateSeedPending } from "@/lib/worktree/pending-epic-create-seeds";
import { base64ToBytes } from "@/lib/composer/image-base64";
import type { HostRpcRegistry } from "@/lib/host";

interface ResolvedAppearanceRead extends WorkspaceAppearanceRead {
  readonly editable: boolean;
  readonly assetRefreshKey: number;
}

// Referenced bytes can change while the configuration itself stays equal.
// Each read must allow asset consumers to re-stat that unchanged path.
let nextAssetRefreshKey = 1;

function takeAssetRefreshKey(): number {
  return nextAssetRefreshKey++;
}

function appearanceReadIsCurrent(
  signal: AbortSignal,
  accountId: string | null,
  session: number | undefined,
): boolean {
  return (
    session !== undefined &&
    !signal.aborted &&
    isAppearanceSessionCurrent(accountId, session)
  );
}

function editableRead(read: WorkspaceAppearanceRead): boolean {
  return (
    read.canonicalSourceRoot !== null &&
    (read.status === "absent" ||
      read.status === "present" ||
      (read.status === "malformed" && read.appearance !== null))
  );
}

function canEditAppearance(
  readSupport: boolean | null,
  writeSupport: boolean | null,
  query: {
    isSuccess: boolean;
    data: ResolvedAppearanceRead | null | undefined;
  },
): boolean {
  return (
    writeSupport === true &&
    readSupport !== false &&
    query.isSuccess &&
    query.data?.editable === true
  );
}

function appearanceScopeFor(
  accountId: string | null,
  hostId: string | null,
  read: WorkspaceAppearanceRead | null,
): AppearanceScope | null {
  if (
    accountId === null ||
    hostId === null ||
    read === null ||
    read.canonicalSourceRoot === null
  )
    return null;
  return { accountId, hostId, canonicalSourceRoot: read.canonicalSourceRoot };
}

function fallbackReadStatus(
  status: WorkspaceAppearanceRead["status"] | undefined,
): boolean {
  return !["present", "absent", "non-git"].includes(status ?? "");
}

function resolvedReadSource(
  read: WorkspaceAppearanceRead,
  previous: WorkspaceAppearanceRead | null | undefined,
  fallback: WorkspaceAppearanceRead | null | undefined,
): string | null {
  if (read.canonicalSourceRoot !== null) return read.canonicalSourceRoot;
  if (read.status === "unavailable" || read.status === "malformed")
    return (
      previous?.canonicalSourceRoot ?? fallback?.canonicalSourceRoot ?? null
    );
  return null;
}

function rememberAppearanceRead(
  queryClient: QueryClient,
  location: { accountId: string; hostId: string; workspacePath: string },
  read: WorkspaceAppearanceRead,
): void {
  const { accountId, hostId, workspacePath } = location;
  if (useAuthStore.getState().contextMetadata?.userId !== accountId) return;
  const source = read.canonicalSourceRoot;
  if (source !== null) {
    queryClient.setQueryData(
      appearanceQueryKeys.source(accountId, hostId, source),
      read,
    );
    void writeAppearanceSnapshot(
      { accountId, hostId, canonicalSourceRoot: source },
      read,
    ).catch(() => {});
  }
  queryClient.setQueryData(
    appearanceQueryKeys.fallback(accountId, hostId, workspacePath),
    read,
  );
  void writeAppearanceSource(accountId, hostId, workspacePath, source).catch(
    () => {},
  );
}

export function useWorkspaceAppearance(args: {
  readonly hostId: string | null;
  readonly workspacePath: string | null;
}) {
  const { hostId, workspacePath } = args;
  const accountId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? null,
  );
  const boundClient = useHostClientForHostId(hostId);
  const client = hostId === null ? null : boundClient;
  const readSupport = useHostMethodSupport(hostId, "workspace.getAppearance");
  const writeSupport = useHostMethodSupport(hostId, "workspace.setAppearance");
  const enabled =
    accountId !== null && hostId !== null && workspacePath !== null;
  const fallback = useQuery(
    queryOptions({
      queryKey: appearanceQueryKeys.fallback(accountId, hostId, workspacePath),
      queryFn: async () => {
        if (accountId === null || hostId === null || workspacePath === null)
          return null;
        const source = await readAppearanceSource(
          accountId,
          hostId,
          workspacePath,
        );
        return source === null
          ? null
          : readAppearanceSnapshot({
              accountId,
              hostId,
              canonicalSourceRoot: source,
            });
      },
      enabled,
      staleTime: Infinity,
    }),
  );
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "workspace.getAppearance",
    ResolvedAppearanceRead | null,
    number
  >({
    client,
    method: "workspace.getAppearance",
    params: { workspacePaths: workspacePath === null ? [] : [workspacePath] },
    cacheKeyIdentity: [accountId],
    options: {
      enabled:
        accountId !== null &&
        workspacePath !== null &&
        readSupport !== false &&
        fallback.isFetched,
      retry: false,
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    captureRequestContext: captureAppearanceSession,
    mapResponse: async ({
      response,
      queryClient,
      queryKey,
      requestContext,
      signal,
    }) => {
      if (!appearanceReadIsCurrent(signal, accountId, requestContext))
        return null;
      const read = response.appearances.find(
        (entry) => entry.workspacePath === workspacePath,
      );
      if (
        read === undefined ||
        accountId === null ||
        hostId === null ||
        workspacePath === null
      )
        return null;
      const previousRead =
        queryClient.getQueryData<ResolvedAppearanceRead | null>(queryKey);
      const source = resolvedReadSource(read, previousRead, fallback.data);
      let previous =
        source === null
          ? null
          : (queryClient.getQueryData<WorkspaceAppearanceRead>(
              appearanceQueryKeys.source(accountId, hostId, source),
            ) ??
            previousRead ??
            fallback.data ??
            null);
      if (source !== null && previous?.canonicalSourceRoot !== source) {
        previous = await readAppearanceSnapshot({
          accountId,
          hostId,
          canonicalSourceRoot: source,
        });
      }
      if (!appearanceReadIsCurrent(signal, accountId, requestContext))
        return null;
      if (source !== null)
        previous =
          queryClient.getQueryData<WorkspaceAppearanceRead>(
            appearanceQueryKeys.source(accountId, hostId, source),
          ) ?? previous;
      const merged = mergeAppearanceRead(
        { ...read, canonicalSourceRoot: source },
        previous,
      );
      rememberAppearanceRead(
        queryClient,
        { accountId, hostId, workspacePath },
        merged,
      );
      return {
        ...merged,
        editable: editableRead(read),
        assetRefreshKey: takeAssetRefreshKey(),
      };
    },
  });
  const appearance = enabled ? (query.data ?? fallback.data ?? null) : null;
  const canEdit = canEditAppearance(readSupport, writeSupport, query);
  const scope = appearanceScopeFor(accountId, hostId, appearance);
  const isFallback =
    query.isError ||
    readSupport === false ||
    fallbackReadStatus(query.data?.status);
  return {
    query,
    appearance,
    scope,
    canEdit,
    readSupport,
    writeSupport,
    isFallback,
    assetRefreshKey: query.data?.assetRefreshKey ?? 0,
  };
}

export function useDraftAppearance(args: {
  readonly hostId: string | null;
  readonly folders: readonly string[];
  readonly primaryPath: string | null;
}) {
  return useWorkspaceAppearance({
    hostId: args.hostId,
    workspacePath: resolvePrimaryPath(args.folders, args.primaryPath),
  });
}

export function useEpicAppearanceSource(args: {
  readonly hostId: string | null;
  readonly epicId: string;
}) {
  const boundClient = useHostClientForHostId(args.hostId);
  const bindings = useWorktreeListBindingsForEpicForClient({
    client: args.hostId === null ? null : boundClient,
    epicId: args.epicId,
    enabled: args.hostId !== null && !isEpicCreateSeedPending(args.epicId),
  });
  const primary = bindings.data?.rows.find((row) => row.isPrimary);
  return {
    hostId: primary?.hostId ?? args.hostId,
    workspacePath: primary?.workspacePath ?? null,
  };
}

export function useEpicAppearance(args: {
  readonly hostId: string | null;
  readonly epicId: string;
}) {
  return useWorkspaceAppearance(useEpicAppearanceSource(args));
}

export function useWorkspaceSetAppearance(args: {
  readonly hostId: string | null;
}) {
  const boundClient = useHostClientForHostId(args.hostId);
  // A `null` host must not fall through to the app-wide client: identity is a
  // write to one machine's checkout. `useHostMutation` rejects on a null client.
  const client = args.hostId === null ? null : boundClient;
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "workspace.setAppearance",
    { hostId: string; accountId: string | null; session: number }
  >({
    client,
    method: "workspace.setAppearance",
    mapVariables: (variables: WorkspaceSetAppearanceRequest) => variables,
    options: {
      mutationKey: workspaceMutationKeys.setAppearance(),
      onMutate: async () => {
        const hostId = args.hostId;
        if (hostId === null)
          throw new Error("No host is available to save to.");
        const context = {
          hostId,
          accountId: useAuthStore.getState().contextMetadata?.userId ?? null,
          session: captureAppearanceSession(),
        };
        await queryClient.cancelQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.getAppearance",
          ),
        });
        if (
          context.accountId === null ||
          !isAppearanceSessionCurrent(context.accountId, context.session)
        )
          throw new Error("The appearance editing session has ended.");
        return context;
      },
      onSuccess: async (response, variables, context) => {
        if (
          context.accountId === null ||
          !isAppearanceSessionCurrent(context.accountId, context.session)
        )
          return;
        await queryClient.cancelQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.getAppearance",
          ),
        });
        if (!isAppearanceSessionCurrent(context.accountId, context.session))
          return;
        const read = response.appearance;
        const source = read.canonicalSourceRoot;
        if (source !== null) {
          const scope = {
            accountId: context.accountId,
            hostId: context.hostId,
            canonicalSourceRoot: source,
          };
          const key = appearanceQueryKeys.source(
            context.accountId,
            context.hostId,
            source,
          );
          const merged = mergeAppearanceRead(
            read,
            queryClient.getQueryData<WorkspaceAppearanceRead>(key) ?? null,
          );
          queryClient.setQueryData(key, merged);
          queryClient.setQueriesData<WorkspaceAppearanceRead | null>(
            {
              queryKey: appearanceQueryKeys.fallbackScope(
                context.accountId,
                context.hostId,
              ),
            },
            (previous) =>
              previous?.canonicalSourceRoot === source
                ? { ...merged, workspacePath: previous.workspacePath }
                : previous,
          );
          const assetRefreshKey = takeAssetRefreshKey();
          queryClient.setQueriesData<ResolvedAppearanceRead | null>(
            {
              queryKey: hostQueryKeys.methodScope(
                context.hostId,
                "workspace.getAppearance",
              ),
              predicate: (query) => query.queryKey.at(-1) === context.accountId,
            },
            (previous) =>
              previous?.canonicalSourceRoot === source
                ? {
                    ...merged,
                    workspacePath: previous.workspacePath,
                    editable: editableRead(read),
                    assetRefreshKey,
                  }
                : previous,
          );
          const upload = variables.upload;
          const uploaded =
            upload === null ? null : base64ToBytes(upload.dataBase64);
          const icon = read.appearance?.icon;
          await Promise.all([
            writeAppearanceSnapshot(scope, merged),
            writeAppearanceSource(
              context.accountId,
              context.hostId,
              variables.workspacePath,
              source,
            ),
            // Seed the local cache with the bytes just accepted, so the icon
            // renders before the host round-trips its own copy back.
            ...(upload !== null && uploaded !== null && icon?.kind === "image"
              ? [
                  writeAppearanceBlob(
                    scope,
                    icon.path,
                    new Blob([uploaded], { type: upload.mediaType }),
                  ),
                ]
              : []),
          ]).catch(() => {});
        }
        await queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "workspace.getAppearance",
          ),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't save repository identity."),
    },
  });
}
