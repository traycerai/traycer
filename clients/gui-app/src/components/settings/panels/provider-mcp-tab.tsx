import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Info,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderMcpCapabilities,
  ProviderMcpServer,
  ProviderMcpServerStatus,
  ProviderMcpTool,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { useProvidersMcpDiscover } from "@/hooks/providers/use-providers-mcp-discover-mutation";
import { useProvidersMcpAuth } from "@/hooks/providers/use-providers-mcp-auth-mutation";
import { isProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";
import { mcpBinaryAbsentNotice } from "./provider-mcp-binary-gate";
import { redactLogText } from "@/lib/logger";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";
import type { McpPendingAuthEntry } from "@/stores/settings/mcp-pending-auth-store";
import { useMcpPendingAuthStore } from "@/stores/settings/mcp-pending-auth-store";
import { ProviderMcpAddDialog } from "./provider-mcp-add-dialog";
import {
  McpScopePicker,
  type McpScopeTarget,
} from "./provider-mcp-scope-picker";
import {
  filterProviderMcpServers,
  isProviderListSearchActive,
} from "./provider-list-search-filter";
import {
  ProviderListSearch,
  ProviderListSearchEmptyState,
} from "./provider-list-search";
import { useProviderNativeScope } from "./use-provider-native-scope";

const EMPTY_MCP_SERVERS: readonly ProviderMcpServer[] = [];

/**
 * The one definition of "this server's auth has not settled yet". Both the
 * prune below and the pending-entry sweep effect decide settledness from the
 * same list, so they have to agree by construction — two copies of the status
 * set would silently diverge the moment a new pending-ish status appears.
 * A server missing from the list has settled by disappearing.
 */
function isServerAuthPending(server: ProviderMcpServer | undefined): boolean {
  return (
    server !== undefined &&
    (server.status === "connecting" || server.status === "needs_auth")
  );
}

/**
 * Drop names that have settled (gone / not connecting|needs_auth).
 * Returns the same `awaiting` reference when nothing changed so render-time
 * state adjustment can compare by identity.
 */
function pruneAuthAwaiting(
  awaiting: ReadonlySet<string>,
  servers: readonly ProviderMcpServer[],
): ReadonlySet<string> {
  if (awaiting.size === 0) return awaiting;
  const byName = new Map(servers.map((s) => [s.name, s]));
  const next = new Set<string>();
  for (const name of awaiting) {
    if (isServerAuthPending(byName.get(name))) {
      next.add(name);
    }
  }
  if (next.size === awaiting.size) {
    let same = true;
    for (const name of next) {
      if (!awaiting.has(name)) {
        same = false;
        break;
      }
    }
    if (same) return awaiting;
  }
  return next;
}

interface ResumeOauthPollingInputs {
  readonly pendingAuthEntries: Readonly<Record<string, McpPendingAuthEntry>>;
  readonly providerId: ProviderId;
  readonly effectiveScope: ProviderNativeScope;
  readonly listWorkspaceRoot: string | null;
  readonly hostId: string | null;
}

function resumeOauthPollingInputsEqual(
  a: ResumeOauthPollingInputs,
  b: ResumeOauthPollingInputs,
): boolean {
  return (
    a.pendingAuthEntries === b.pendingAuthEntries &&
    a.providerId === b.providerId &&
    a.effectiveScope === b.effectiveScope &&
    a.listWorkspaceRoot === b.listWorkspaceRoot &&
    a.hostId === b.hostId
  );
}

/**
 * Resumes OAuth polling after a settings navigation, from the pending-auth
 * store. Adjusted during render (guarded by comparing against the
 * last-applied inputs) rather than in an effect - `pendingAuthEntries` is
 * already reactive via the Zustand selector hook, so no effect is needed to
 * detect changes; see `useResetFormOnReopen` in provider-mcp-add-dialog.tsx
 * for the same pattern.
 */
function useResumeOauthPolling(
  inputs: ResumeOauthPollingInputs,
  setAuthInstruction: (instruction: string) => void,
  setAuthAwaitingNames: (
    updater: (prev: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void,
): void {
  const [seenInputs, setSeenInputs] = useState<ResumeOauthPollingInputs | null>(
    null,
  );
  if (
    seenInputs !== null &&
    resumeOauthPollingInputsEqual(seenInputs, inputs)
  ) {
    return;
  }
  setSeenInputs(inputs);
  const resumed = new Set<string>();
  let resumedInstruction: string | null = null;
  for (const entry of Object.values(inputs.pendingAuthEntries)) {
    if (
      entry.key.providerId === inputs.providerId &&
      entry.key.scope === inputs.effectiveScope &&
      entry.key.workspaceRoot === inputs.listWorkspaceRoot &&
      (inputs.hostId === null || entry.hostId === inputs.hostId)
    ) {
      resumed.add(entry.key.serverName);
      if (entry.instruction !== null) {
        resumedInstruction = redactLogText(entry.instruction);
      }
    }
  }
  if (resumedInstruction !== null) {
    setAuthInstruction(resumedInstruction);
  }
  if (resumed.size === 0) return;
  setAuthAwaitingNames((prev) => {
    let changed = false;
    const next = new Set(prev);
    for (const name of resumed) {
      if (!next.has(name)) {
        next.add(name);
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}

/**
 * Action affordances for the currently selected scope. R04 advertises
 * per-action scope tables — a verb supported only for global must not appear
 * when the user is viewing project (and vice versa).
 */
function mcpMutationFlags(
  capabilities: ProviderMcpCapabilities,
  effectiveScope: ProviderNativeScope,
) {
  const scopes = capabilities.actionScopes;
  const canAdd = scopes.add.includes(effectiveScope);
  const canRemove = scopes.remove.includes(effectiveScope);
  // update is intentionally omitted: every contract sets updateServer: "none"
  // and actionScopes.update: [], so the edit affordance was maintained dead
  // code. Restore canUpdate + pencil + editTarget + dialog mode="edit" when a
  // provider actually implements update.
  const canToggleServer = scopes.toggleServer.includes(effectiveScope);
  const canToggleTool = scopes.toggleTool.includes(effectiveScope);
  const canDiscover = scopes.discover.includes(effectiveScope);
  const canAuth = scopes.auth.includes(effectiveScope);
  const toolsReadOnly =
    capabilities.perToolBacking === "degraded-server-level" ||
    capabilities.perToolBacking === "none" ||
    !canToggleTool;
  return {
    canAdd,
    canRemove,
    canToggleServer,
    canDiscover,
    canAuth,
    toolsReadOnly,
  };
}

export function ProviderMcpTab(props: {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderMcpCapabilities;
  readonly providerLabel: string;
  /**
   * `state.cliBinaryResolved` - whether the host resolved a runnable CLI for
   * this provider. Passed down rather than re-derived from `candidates`: it is
   * the same value that decided whether the capabilities above were gated, so
   * the explanation can never disagree with what it explains.
   */
  readonly cliBinaryResolved: boolean;
}): ReactNode {
  const { providerId, capabilities, providerLabel, cliBinaryResolved } = props;
  const scopeState = useProviderNativeScope(capabilities.actionScopes.list);
  const {
    hostId,
    targets,
    workspaceRoot,
    setWorkspaceRoot,
    browseForWorkspace,
    browsePending,
    multiWorkspace,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    listWorkspaceRoot,
    listEnabled,
    workspacesLoading,
  } = scopeState;

  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [pendingServerNames, setPendingServerNames] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );
  // After opening an authorizationUrl, poll mcpList until the row settles.
  // Settled names are pruned during render (no sync effect).
  const [authAwaitingNames, setAuthAwaitingNames] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [authInstruction, setAuthInstruction] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const pendingAuthUpsert = useMcpPendingAuthStore((s) => s.upsert);
  const pendingAuthRemove = useMcpPendingAuthStore((s) => s.remove);
  const pendingAuthEntries = useMcpPendingAuthStore((s) => s.entries);

  // Shadow badges: when viewing Global with a workspace, also read project
  // names so host-side project-overrides-global can be labeled.
  const projectListForShadow = useProvidersMcpList({
    providerId,
    scope: "project",
    workspaceRoot,
    enabled:
      multiScope && effectiveScope === "global" && workspaceRoot !== null,
    pollWhilePending: false,
  });

  // Primary list: poll while any auth-awaiting name is still unsettled.
  // Settled names are pruned during render below so the next pass stops polling.
  const listQuery = useProvidersMcpList({
    providerId,
    scope: effectiveScope,
    workspaceRoot: listWorkspaceRoot,
    enabled: listEnabled,
    pollWhilePending: authAwaitingNames.size > 0,
  });

  const listData = listQuery.data;
  const servers = listData?.servers ?? EMPTY_MCP_SERVERS;
  const filteredServers = useMemo(
    () => filterProviderMcpServers(servers, searchQuery),
    [servers, searchQuery],
  );
  const serverSearchActive = isProviderListSearchActive(searchQuery);

  // Adjust auth-awaiting set from latest list data during render (React
  // "storing information from previous renders" pattern) — avoids setState
  // inside an effect.
  //
  // Gated on having list data, for the same reason the store sweep below is:
  // `servers` falls back to empty whenever a fetch is in flight, and an empty
  // list reads as "everything awaited has settled".
  //
  // Reachable on a plain mount, not just in theory. `useResumeOauthPolling`
  // runs during render, so a resumed entry lands in `authAwaitingNames` on the
  // FIRST pass — and the second pass prunes it while the list request is still
  // in flight. The set empties, `pollWhilePending` goes false, and nothing
  // picks the finished OAuth up: `needs_auth` alone does not drive the poll
  // cadence, only `discoveryPending`/`connecting` do. A scope or workspace
  // switch mid-login hits the same window, since swapping the query key drops
  // `data` back to undefined with no `placeholderData` covering the gap.
  const prunedAuthAwaiting =
    listData === undefined
      ? authAwaitingNames
      : pruneAuthAwaiting(authAwaitingNames, listData.servers);
  if (prunedAuthAwaiting !== authAwaitingNames) {
    setAuthAwaitingNames(prunedAuthAwaiting);
  }

  // The store cleanup that used to run in the render body above. It cannot
  // stay there: the write notifies this very component (it subscribes to
  // `entries`), and a render React discards would have mutated it anyway. It
  // also cannot be handed down from the prune — `setAuthAwaitingNames` above
  // re-renders immediately with nothing left to diff, so by the time effects
  // run for the committed render the retired names are gone. So this reads the
  // store directly and re-derives settledness from the list through the same
  // `isServerAuthPending` rule the prune uses. Self-limiting: removing an entry is what
  // changes `pendingAuthEntries`, and the next pass finds nothing to remove.
  useEffect(() => {
    // A list we have not received yet says nothing about what settled. Without
    // this, first paint sees an empty `servers` and would wipe every pending
    // entry the resume path just restored.
    if (listData === undefined) return;
    const byName = new Map(listData.servers.map((s) => [s.name, s]));
    for (const entry of Object.values(pendingAuthEntries)) {
      const key = entry.key;
      if (
        key.providerId !== providerId ||
        key.scope !== effectiveScope ||
        key.workspaceRoot !== listWorkspaceRoot
      ) {
        continue;
      }
      if (!isServerAuthPending(byName.get(key.serverName))) {
        pendingAuthRemove(key);
      }
    }
  }, [
    listData,
    pendingAuthEntries,
    pendingAuthRemove,
    providerId,
    effectiveScope,
    listWorkspaceRoot,
  ]);

  const shadowedNames = useMemo(() => {
    if (effectiveScope !== "global") return new Set<string>();
    const projectServers = projectListForShadow.data?.servers;
    if (projectServers === undefined) return new Set<string>();
    return new Set(projectServers.map((s) => s.name));
  }, [effectiveScope, projectListForShadow.data?.servers]);

  const mutate = useProvidersMcpMutate();
  const discover = useProvidersMcpDiscover();
  const auth = useProvidersMcpAuth();
  const openExternalLink = useRunnerOpenExternalLink();

  const existingNames = useMemo(() => servers.map((s) => s.name), [servers]);

  // Hoisted out of JSX: `eslint --fix` (react/jsx-no-leaked-render) rewrites a
  // logical `&&` inside a JSX attribute into `cond ? value : null`, which makes
  // this `boolean | null` and fails the dialog's `isPending: boolean` prop.
  const deleteDialogPending = mutate.isPending && deleteTarget !== null;

  const {
    canAdd,
    canRemove,
    canToggleServer,
    canDiscover,
    canAuth,
    toolsReadOnly,
  } = mcpMutationFlags(capabilities, effectiveScope);

  const markPending = useCallback((name: string, pending: boolean) => {
    setPendingServerNames((prev) => {
      const next = new Set(prev);
      if (pending) next.add(name);
      else next.delete(name);
      return next;
    });
  }, []);

  const clearRowError = useCallback((name: string) => {
    setRowErrors((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const setRowError = useCallback((name: string, message: string) => {
    setRowErrors((prev) => {
      const next = new Map(prev);
      next.set(name, message);
      return next;
    });
  }, []);

  const scopeTuple = useMemo(
    () => ({
      providerId,
      scope: effectiveScope,
      workspaceRoot: listWorkspaceRoot,
    }),
    [providerId, effectiveScope, listWorkspaceRoot],
  );

  useResumeOauthPolling(
    {
      pendingAuthEntries,
      providerId,
      effectiveScope,
      listWorkspaceRoot,
      hostId,
    },
    setAuthInstruction,
    setAuthAwaitingNames,
  );

  const handleRefresh = useCallback(
    (serverName: string) => {
      markPending(serverName, true);
      clearRowError(serverName);
      discover.mutate(
        { ...scopeTuple, serverName, forceRefresh: true },
        {
          onSettled: () => {
            markPending(serverName, false);
          },
        },
      );
    },
    [clearRowError, discover, markPending, scopeTuple],
  );

  const handleToggleServer = useCallback(
    (server: ProviderMcpServer, enabled: boolean) => {
      markPending(server.name, true);
      clearRowError(server.name);
      mutate.mutate(
        {
          ...scopeTuple,
          mutation: { action: "toggleServer", name: server.name, enabled },
          suppressToast: true,
        },
        {
          onError: (error) => {
            if (isProviderNativeRpcError(error)) {
              setRowError(
                server.name,
                nativeErrorMessage(error.nativeCode, error.nativeDetail),
              );
            }
          },
          onSettled: () => {
            markPending(server.name, false);
          },
        },
      );
    },
    [clearRowError, markPending, mutate, scopeTuple, setRowError],
  );

  const handleToggleTool = useCallback(
    (serverName: string, toolName: string, enabled: boolean) => {
      markPending(serverName, true);
      clearRowError(serverName);
      mutate.mutate(
        {
          ...scopeTuple,
          mutation: {
            action: "toggleTool",
            serverName,
            toolName,
            enabled,
          },
          suppressToast: true,
        },
        {
          onError: (error) => {
            if (isProviderNativeRpcError(error)) {
              setRowError(
                serverName,
                nativeErrorMessage(error.nativeCode, error.nativeDetail),
              );
            }
          },
          onSettled: () => {
            markPending(serverName, false);
          },
        },
      );
    },
    [clearRowError, markPending, mutate, scopeTuple, setRowError],
  );

  const handleToggleAllTools = useCallback(
    async (server: ProviderMcpServer, enabled: boolean) => {
      markPending(server.name, true);
      clearRowError(server.name);
      try {
        for (const tool of server.tools) {
          if (tool.readOnly || tool.enabled === enabled) continue;
          await mutate.mutateAsync({
            ...scopeTuple,
            mutation: {
              action: "toggleTool",
              serverName: server.name,
              toolName: tool.name,
              enabled,
            },
            suppressToast: true,
          });
        }
      } catch (error) {
        if (isProviderNativeRpcError(error)) {
          setRowError(
            server.name,
            nativeErrorMessage(error.nativeCode, error.nativeDetail),
          );
        }
      } finally {
        markPending(server.name, false);
      }
    },
    [clearRowError, markPending, mutate, scopeTuple, setRowError],
  );

  const handleAuth = useCallback(
    (serverName: string, action: "login" | "logout" | "forceReauth") => {
      markPending(serverName, true);
      setAuthInstruction(null);
      clearRowError(serverName);
      auth.mutate(
        {
          ...scopeTuple,
          auth: { action, serverName, code: undefined },
        },
        {
          onSuccess: (data) => {
            const result = data.result;
            const authKey = {
              providerId: scopeTuple.providerId,
              scope: scopeTuple.scope,
              workspaceRoot: scopeTuple.workspaceRoot,
              serverName,
            };
            if (result.kind === "authorizationUrl") {
              setAuthAwaitingNames((prev) => new Set(prev).add(serverName));
              if (hostId !== null) {
                pendingAuthUpsert({
                  key: authKey,
                  hostId,
                  startedAt: Date.now(),
                  authorizationUrl: result.authorizationUrl,
                  instruction: null,
                });
              }
              openExternalLink.mutate(result.authorizationUrl);
            } else if (result.kind === "pendingInstruction") {
              setAuthAwaitingNames((prev) => new Set(prev).add(serverName));
              const instruction = redactLogText(result.instruction);
              setAuthInstruction(instruction);
              if (hostId !== null) {
                pendingAuthUpsert({
                  key: authKey,
                  hostId,
                  startedAt: Date.now(),
                  authorizationUrl: null,
                  instruction: result.instruction,
                });
              }
            } else if (result.kind === "pending") {
              setAuthAwaitingNames((prev) => new Set(prev).add(serverName));
              if (hostId !== null) {
                pendingAuthUpsert({
                  key: authKey,
                  hostId,
                  startedAt: Date.now(),
                  authorizationUrl: null,
                  instruction: null,
                });
              }
            } else if (result.kind === "unsupported") {
              setAuthInstruction(
                redactLogText(
                  result.reason ??
                    "This provider does not support this auth action.",
                ),
              );
            }
          },
          onSettled: () => {
            markPending(serverName, false);
          },
        },
      );
    },
    [
      auth,
      clearRowError,
      hostId,
      markPending,
      openExternalLink,
      pendingAuthUpsert,
      scopeTuple,
    ],
  );

  const handleDelete = useCallback(() => {
    if (deleteTarget === null) return;
    const name = deleteTarget;
    markPending(name, true);
    clearRowError(name);
    mutate.mutate(
      {
        ...scopeTuple,
        mutation: { action: "remove", name },
        suppressToast: true,
      },
      {
        onError: (error) => {
          if (isProviderNativeRpcError(error)) {
            setRowError(
              name,
              nativeErrorMessage(error.nativeCode, error.nativeDetail),
            );
          }
        },
        onSettled: () => {
          markPending(name, false);
          setDeleteTarget(null);
        },
      },
    );
  }, [
    clearRowError,
    deleteTarget,
    markPending,
    mutate,
    scopeTuple,
    setRowError,
  ]);

  // A freshly added folder is what the user just went looking for, so it
  // becomes the selection - otherwise the picker closes back onto Global and
  // the add reads as having done nothing.
  const handleBrowse = useCallback(() => {
    void browseForWorkspace()
      .then((path) => {
        if (path === null) return;
        setWorkspaceRoot(path);
        setScope("project");
      })
      // `pickAndPrepareFolders` guards only its `prepareFoldersAsync` call;
      // the shared folder picker's `requestPick` is awaited bare, so a failure
      // there rejects out of `browseForWorkspace`. Without this the rejection is
      // unhandled and the user is told nothing at all - the popover simply
      // stays as it was, which reads as the click having missed.
      .catch(() => {
        reportableErrorToast("Couldn't open the folder picker.", undefined, {
          title: "Could not add workspace folders",
          message: "The folder picker failed to open.",
          code: null,
          source: "Workspace folders",
        });
      });
  }, [browseForWorkspace, setScope, setWorkspaceRoot]);

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setAddOpen(false);
    }
  }, []);

  const handleAdded = useCallback(
    (args: { name: string; requiresAuth: boolean }) => {
      if (args.requiresAuth && canAuth) {
        handleAuth(args.name, "login");
      }
    },
    [canAuth, handleAuth],
  );

  return (
    <div className="flex flex-col gap-3" data-testid="provider-mcp-tab">
      <McpScopeHeader
        multiScope={multiScope}
        effectiveScope={effectiveScope}
        targets={targets}
        workspaceRoot={workspaceRoot}
        workspacesLoading={workspacesLoading}
        canAdd={canAdd}
        projectNeedsWorkspace={projectNeedsWorkspace}
        browsePending={browsePending}
        onBrowse={handleBrowse}
        onScopeChange={setScope}
        onWorkspaceRootChange={setWorkspaceRoot}
        onAdd={() => {
          setAddOpen(true);
        }}
      />

      <McpCapabilityNotices
        capabilities={capabilities}
        authInstruction={authInstruction}
        binaryAbsentNotice={mcpBinaryAbsentNotice(
          capabilities,
          cliBinaryResolved,
          providerLabel,
        )}
      />

      {!projectNeedsWorkspace ? (
        <ProviderListSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          resultCount={filteredServers.length}
          resourceLabel="servers"
        />
      ) : null}

      <McpServerList
        projectNeedsWorkspace={projectNeedsWorkspace}
        multiWorkspace={multiWorkspace}
        workspacesLoading={workspacesLoading}
        listPending={listQuery.isPending}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        onRetryList={() => {
          void listQuery.refetch();
        }}
        servers={filteredServers}
        unfilteredServerCount={servers.length}
        searchQuery={searchQuery}
        searchActive={serverSearchActive}
        providerLabel={providerLabel}
        capabilities={capabilities}
        shadowedNames={shadowedNames}
        pendingServerNames={pendingServerNames}
        rowErrors={rowErrors}
        canRemove={canRemove}
        canToggleServer={canToggleServer}
        canDiscover={canDiscover}
        canAuth={canAuth}
        toolsReadOnly={toolsReadOnly}
        onRefresh={handleRefresh}
        onToggleServer={handleToggleServer}
        onToggleTool={handleToggleTool}
        onToggleAllTools={(server, enabled) => {
          void handleToggleAllTools(server, enabled);
        }}
        onAuth={handleAuth}
        onDelete={setDeleteTarget}
      />

      <ProviderMcpAddDialog
        open={addOpen}
        onOpenChange={handleDialogOpenChange}
        mode="add"
        initialServer={null}
        providerLabel={providerLabel}
        capabilities={capabilities}
        existingNames={existingNames}
        scopeTuple={scopeTuple}
        onAdded={handleAdded}
      />

      <ConfirmDestructiveDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Remove MCP server"
        description={
          deleteTarget === null
            ? ""
            : `Remove “${deleteTarget}” from this provider's ${effectiveScope} config?`
        }
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={deleteDialogPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function McpScopeHeader(props: {
  readonly multiScope: boolean;
  readonly effectiveScope: ProviderNativeScope;
  readonly targets: readonly McpScopeTarget[];
  readonly workspaceRoot: string | null;
  readonly workspacesLoading: boolean;
  readonly canAdd: boolean;
  readonly projectNeedsWorkspace: boolean;
  readonly browsePending: boolean;
  readonly onBrowse: () => void;
  readonly onScopeChange: (scope: ProviderNativeScope) => void;
  readonly onWorkspaceRootChange: (path: string) => void;
  readonly onAdd: () => void;
}): ReactNode {
  // A provider that lists only globally has no destination to choose, so it
  // gets a plain statement rather than a picker holding one dead option. The
  // wording is the same promise the Global row makes inside the picker, so the
  // two surfaces never describe the same scope differently.
  const globalOnly = !props.multiScope && props.effectiveScope === "global";

  // The picker is NEVER disabled, and that is load-bearing rather than an
  // oversight. It used to go dead on "zero resolvable workspaces and no Global
  // to fall back to" - which is precisely the project-only provider on a host
  // this client has opened no folders on. The add-a-folder action lives INSIDE
  // the popover, so disabling the trigger sealed off the only way out of that
  // state: no workspaces, no way to add one, and Project is the only scope.
  // An empty list is now something the user can act on, so the trigger stays
  // live and the popover explains itself.

  // One toolbar row, two controls of the SAME height (`h-7` / `size="sm"`).
  // `items-center` rather than `items-start`: nothing here is taller than one
  // line any more, which is the whole point of the single-line trigger.
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {globalOnly ? (
        <p className="text-ui-xs text-muted-foreground">
          Applies to every workspace on this host.
        </p>
      ) : (
        <McpScopePicker
          multiScope={props.multiScope}
          effectiveScope={props.effectiveScope}
          targets={props.targets}
          workspaceRoot={props.workspaceRoot}
          loading={props.workspacesLoading}
          browsePending={props.browsePending}
          onBrowse={props.onBrowse}
          locationLabel="MCP config location"
          onSelectGlobal={() => {
            props.onScopeChange("global");
          }}
          onSelectProject={(path) => {
            // Order matters only for readability - both land in the same commit
            // phase - but picking a folder IS picking Project scope. Making the
            // row do both is the point: the old chip pair let you sit in Global
            // with a folder selected and no indication which one.
            props.onWorkspaceRootChange(path);
            props.onScopeChange("project");
          }}
        />
      )}
      {props.canAdd && !props.projectNeedsWorkspace ? (
        <Button type="button" size="sm" onClick={props.onAdd}>
          <Plus className="size-3.5" />
          Add MCP server
        </Button>
      ) : null}
    </div>
  );
}

function McpCapabilityNotices(props: {
  readonly capabilities: ProviderMcpCapabilities;
  readonly authInstruction: string | null;
  readonly binaryAbsentNotice: string | null;
}): ReactNode {
  return (
    <>
      {/*
        First, and the only one of these three painted as a warning rather than
        a muted aside: the others describe a permanent property of the provider,
        while this one describes controls that are missing RIGHT NOW from the
        pane the user is looking at, and names the fix.
      */}
      {props.binaryAbsentNotice !== null ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-ui-xs text-muted-foreground"
          data-testid="mcp-binary-absent-notice"
        >
          {props.binaryAbsentNotice}
        </p>
      ) : null}
      {props.capabilities.stdioDegradeNotice ? (
        <p
          // muted-fill-ok: weak tint delimited by its own border-border/60
          className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
        >
          Stdio servers are config-only under this provider — live connect is
          unavailable in-session.
        </p>
      ) : null}
      {props.authInstruction !== null ? (
        <p
          // muted-fill-ok: weak tint delimited by its own border-border/60
          className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
        >
          {props.authInstruction}
        </p>
      ) : null}
    </>
  );
}

function McpServerList(props: {
  readonly projectNeedsWorkspace: boolean;
  readonly multiWorkspace: boolean;
  readonly workspacesLoading: boolean;
  readonly listPending: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly onRetryList: () => void;
  readonly servers: readonly ProviderMcpServer[];
  readonly unfilteredServerCount: number;
  readonly searchQuery: string;
  readonly searchActive: boolean;
  readonly providerLabel: string;
  readonly capabilities: ProviderMcpCapabilities;
  readonly shadowedNames: ReadonlySet<string>;
  readonly pendingServerNames: ReadonlySet<string>;
  readonly rowErrors: ReadonlyMap<string, string>;
  readonly canRemove: boolean;
  readonly canToggleServer: boolean;
  readonly canDiscover: boolean;
  readonly canAuth: boolean;
  readonly toolsReadOnly: boolean;
  readonly onRefresh: (serverName: string) => void;
  readonly onToggleServer: (
    server: ProviderMcpServer,
    enabled: boolean,
  ) => void;
  readonly onToggleTool: (
    serverName: string,
    toolName: string,
    enabled: boolean,
  ) => void;
  readonly onToggleAllTools: (
    server: ProviderMcpServer,
    enabled: boolean,
  ) => void;
  readonly onAuth: (
    serverName: string,
    action: "login" | "logout" | "forceReauth",
  ) => void;
  readonly onDelete: (serverName: string) => void;
}): ReactNode {
  if (props.projectNeedsWorkspace) {
    if (props.workspacesLoading) {
      return (
        <div className="flex items-center gap-2 py-6 text-ui-sm text-muted-foreground">
          <MutedAgentSpinner />
          Resolving workspaces on this host
        </div>
      );
    }
    if (props.multiWorkspace) {
      return (
        <EmptyState
          title="Select a workspace"
          description="Choose a project workspace above to manage project-scoped MCP servers on this host."
          actionLabel={null}
          onAction={null}
        />
      );
    }
    return (
      <EmptyState
        title="Open a workspace"
        description="Open a workspace on this host to manage project-scoped MCP servers."
        actionLabel={null}
        onAction={null}
      />
    );
  }
  if (props.listPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        Loading MCP servers
      </div>
    );
  }
  if (props.listError) {
    return (
      <EmptyState
        title="Couldn't load MCP servers"
        description={props.errorMessage ?? "Try refreshing or check the host."}
        actionLabel="Retry"
        onAction={props.onRetryList}
      />
    );
  }
  if (props.unfilteredServerCount === 0) {
    return (
      <EmptyState
        title="No MCP servers"
        description={`Add an MCP server so ${props.providerLabel} can use external tools and context.`}
        actionLabel={null}
        onAction={null}
      />
    );
  }
  if (props.searchActive && props.servers.length === 0) {
    return (
      <ProviderListSearchEmptyState
        query={props.searchQuery}
        resourceLabel="servers"
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {props.servers.map((server) => (
        <McpServerRow
          key={server.name}
          server={server}
          capabilities={props.capabilities}
          shadowed={props.shadowedNames.has(server.name)}
          pending={
            props.pendingServerNames.has(server.name) ||
            server.discoveryPending ||
            server.status === "connecting"
          }
          rowError={props.rowErrors.get(server.name) ?? null}
          canRemove={props.canRemove}
          canToggleServer={props.canToggleServer}
          canDiscover={props.canDiscover}
          canAuth={props.canAuth}
          toolsReadOnly={props.toolsReadOnly}
          onRefresh={() => {
            props.onRefresh(server.name);
          }}
          onToggleServer={(enabled) => {
            props.onToggleServer(server, enabled);
          }}
          onToggleTool={(toolName, enabled) => {
            props.onToggleTool(server.name, toolName, enabled);
          }}
          onToggleAllTools={(enabled) => {
            void props.onToggleAllTools(server, enabled);
          }}
          onLogin={() => {
            props.onAuth(server.name, "login");
          }}
          onLogout={() => {
            props.onAuth(server.name, "logout");
          }}
          onForceReauth={() => {
            props.onAuth(server.name, "forceReauth");
          }}
          onDelete={() => {
            props.onDelete(server.name);
          }}
        />
      ))}
    </ul>
  );
}

function EmptyState(props: {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string | null;
  readonly onAction: (() => void) | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
      <div className="text-ui-sm font-medium text-foreground">
        {props.title}
      </div>
      <p className="text-ui-xs text-muted-foreground">{props.description}</p>
      {props.actionLabel !== null && props.onAction !== null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2 self-start"
          onClick={props.onAction}
        >
          {props.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

function serverRowFlags(
  server: ProviderMcpServer,
  capabilities: ProviderMcpCapabilities,
  canAuth: boolean,
) {
  // Auth action buttons require both the action in authActions and the
  // selected scope advertising auth support (actionScopes.auth).
  const showLogin =
    canAuth &&
    capabilities.authActions.includes("login") &&
    (server.status === "needs_auth" || server.status === "error");
  const showLogout =
    canAuth &&
    capabilities.authActions.includes("logout") &&
    server.status === "connected";
  const showForceReauth =
    canAuth &&
    capabilities.authActions.includes("forceReauth") &&
    (server.status === "needs_auth" || server.status === "error");
  const toolsListable =
    server.status === "connected" &&
    !server.configOnly &&
    !server.stdioDegraded;
  return { showLogin, showLogout, showForceReauth, toolsListable };
}

function rowErrorBannerText(
  rowError: string | null,
  server: ProviderMcpServer,
): string | null {
  if (rowError !== null) return rowError;
  if (
    server.statusDetail !== null &&
    (server.status === "error" || server.status === "needs_auth")
  ) {
    return redactLogText(server.statusDetail);
  }
  return null;
}

function McpServerRow(props: {
  readonly server: ProviderMcpServer;
  readonly capabilities: ProviderMcpCapabilities;
  readonly shadowed: boolean;
  readonly pending: boolean;
  readonly rowError: string | null;
  readonly canRemove: boolean;
  readonly canToggleServer: boolean;
  readonly canDiscover: boolean;
  readonly canAuth: boolean;
  readonly toolsReadOnly: boolean;
  readonly onRefresh: () => void;
  readonly onToggleServer: (enabled: boolean) => void;
  readonly onToggleTool: (toolName: string, enabled: boolean) => void;
  readonly onToggleAllTools: (enabled: boolean) => void;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onForceReauth: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const {
    server,
    capabilities,
    shadowed,
    pending,
    rowError,
    canRemove,
    canToggleServer,
    canDiscover,
    canAuth,
    toolsReadOnly,
    onRefresh,
    onToggleServer,
    onToggleTool,
    onToggleAllTools,
    onLogin,
    onLogout,
    onForceReauth,
    onDelete,
  } = props;
  const [open, setOpen] = useState(false);
  const [subTab, setSubTab] = useState<"tools" | "instructions">("tools");

  const statusLabel = statusLabelFor(server);
  const { showLogin, showLogout, showForceReauth, toolsListable } =
    serverRowFlags(server, capabilities, canAuth);

  return (
    <li className="rounded-lg border border-border/60">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-label={
                open ? `Collapse ${server.name}` : `Expand ${server.name}`
              }
            >
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-ui-sm font-medium text-foreground">
                {server.name}
              </span>
              <StatusDot status={server.status} pending={pending} />
              <span className="truncate text-ui-xs text-muted-foreground">
                {statusLabel}
              </span>
              {server.tools.length > 0 ? (
                <span className="text-ui-xs text-muted-foreground">
                  {server.tools.length}{" "}
                  {server.tools.length === 1 ? "tool" : "tools"}
                </span>
              ) : null}
              <ServerRowBadges server={server} shadowed={shadowed} />
            </button>
          </CollapsibleTrigger>

          <ServerRowActions
            serverName={server.name}
            serverEnabled={server.enabled}
            pending={pending}
            showLogin={showLogin}
            showLogout={showLogout}
            showForceReauth={showForceReauth}
            canRemove={canRemove}
            canToggleServer={canToggleServer}
            canDiscover={canDiscover}
            onLogin={onLogin}
            onLogout={onLogout}
            onForceReauth={onForceReauth}
            onRefresh={onRefresh}
            onDelete={onDelete}
            onToggleServer={onToggleServer}
          />
        </div>

        {rowErrorBannerText(rowError, server) !== null ? (
          <p className="border-t border-border/40 px-3 py-2 text-ui-xs text-destructive">
            {rowErrorBannerText(rowError, server)}
          </p>
        ) : null}

        <CollapsibleContent>
          <div className="border-t border-border/40 px-3 py-2">
            {!toolsListable ? (
              <ToolsUnavailableState
                server={server}
                onLogin={
                  canAuth && capabilities.authActions.includes("login")
                    ? onLogin
                    : null
                }
                onRefresh={canDiscover ? onRefresh : null}
                pending={pending}
              />
            ) : (
              <ServerToolsPanel
                server={server}
                capabilities={capabilities}
                toolsReadOnly={toolsReadOnly}
                pending={pending}
                subTab={subTab}
                onSubTabChange={setSubTab}
                onToggleTool={onToggleTool}
                onToggleAllTools={onToggleAllTools}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function ServerRowBadges(props: {
  readonly server: ProviderMcpServer;
  readonly shadowed: boolean;
}): ReactNode {
  const { server, shadowed } = props;
  return (
    <>
      {shadowed ? (
        <Badge
          variant="outline"
          className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal"
        >
          shadowed by project
        </Badge>
      ) : null}
      {server.statusSource === "probe" ? (
        <Badge
          variant="outline"
          className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal text-muted-foreground"
        >
          connectivity check
        </Badge>
      ) : null}
      {server.configOnly ? (
        <Badge
          variant="outline"
          className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal"
        >
          config only
        </Badge>
      ) : null}
      {server.stdioDegraded ? (
        <Badge
          variant="outline"
          className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal"
        >
          stdio degraded
        </Badge>
      ) : null}
    </>
  );
}

function ServerRowActions(props: {
  readonly serverName: string;
  readonly serverEnabled: boolean;
  readonly pending: boolean;
  readonly showLogin: boolean;
  readonly showLogout: boolean;
  readonly showForceReauth: boolean;
  readonly canRemove: boolean;
  readonly canToggleServer: boolean;
  readonly canDiscover: boolean;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onForceReauth: () => void;
  readonly onRefresh: () => void;
  readonly onDelete: () => void;
  readonly onToggleServer: (enabled: boolean) => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {props.pending ? <MutedAgentSpinner /> : null}
      {props.showLogin ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onLogin}
        >
          <LogIn className="size-3.5" />
          Sign in
        </Button>
      ) : null}
      {props.showForceReauth ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onForceReauth}
        >
          Re-authenticate
        </Button>
      ) : null}
      {props.showLogout ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onLogout}
          aria-label={`Log out ${props.serverName}`}
        >
          <LogOut className="size-3.5" />
        </Button>
      ) : null}
      {props.canDiscover ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onRefresh}
          aria-label={`Refresh ${props.serverName}`}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      ) : null}
      {props.canRemove ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onDelete}
          aria-label={`Delete ${props.serverName}`}
        >
          <Trash2 className="size-3.5" />
        </Button>
      ) : null}
      {props.canToggleServer ? (
        <Switch
          checked={props.serverEnabled}
          disabled={props.pending}
          onCheckedChange={props.onToggleServer}
          aria-label={
            props.serverEnabled
              ? `Disable ${props.serverName}`
              : `Enable ${props.serverName}`
          }
        />
      ) : null}
    </div>
  );
}

function ServerToolsPanel(props: {
  readonly server: ProviderMcpServer;
  readonly capabilities: ProviderMcpCapabilities;
  readonly toolsReadOnly: boolean;
  readonly pending: boolean;
  readonly subTab: "tools" | "instructions";
  readonly onSubTabChange: (tab: "tools" | "instructions") => void;
  readonly onToggleTool: (toolName: string, enabled: boolean) => void;
  readonly onToggleAllTools: (enabled: boolean) => void;
}): ReactNode {
  const {
    server,
    capabilities,
    toolsReadOnly,
    pending,
    subTab,
    onSubTabChange,
    onToggleTool,
    onToggleAllTools,
  } = props;

  return (
    <Tabs
      value={subTab}
      onValueChange={(value) => {
        if (value === "tools" || value === "instructions") {
          onSubTabChange(value);
        }
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <TabsList className="h-auto">
          <TabsTrigger value="tools" className="text-ui-xs">
            Tools ({server.tools.length})
          </TabsTrigger>
          {capabilities.instructionsSource !== "none" ? (
            <TabsTrigger value="instructions" className="text-ui-xs">
              Instructions
            </TabsTrigger>
          ) : null}
        </TabsList>
        {!toolsReadOnly && server.tools.length > 0 ? (
          <div className="ml-auto flex items-center gap-2 text-ui-xs text-muted-foreground">
            <button
              type="button"
              className="hover:text-foreground"
              disabled={pending}
              onClick={() => {
                onToggleAllTools(true);
              }}
            >
              Enable all
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="hover:text-foreground"
              disabled={pending}
              onClick={() => {
                onToggleAllTools(false);
              }}
            >
              Disable all
            </button>
            {/*
             * The scope caveat sits on the control it qualifies rather than in
             * a banner above the list: it only ever describes what these two
             * buttons (and the per-tool switches) do, and as a full-width
             * notice it read as a warning about the whole server.
             *
             * A real `<button>`, not an icon with `tabIndex`: Radix's
             * `TooltipTrigger` opens on focus as well as hover, but only for an
             * element that can natively take focus - and a `tabIndex` on a
             * non-interactive element without a role fails
             * jsx-a11y/no-noninteractive-tabindex.
             */}
            {capabilities.traycerSessionsOnlyEnforcement ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="cursor-help appearance-none bg-transparent p-0 text-muted-foreground hover:text-foreground"
                    aria-label="Where tool enable/disable applies"
                  >
                    <Info className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  Tool enable/disable applies to Traycer sessions only for this
                  provider.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
      <TabsContent value="tools" className="mt-0">
        {server.tools.length === 0 ? (
          <p className="py-3 text-center text-ui-xs text-muted-foreground">
            No tools discovered yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {server.tools.map((tool) => (
              <ToolChip
                key={tool.name}
                tool={tool}
                readOnly={toolsReadOnly || tool.readOnly}
                disabled={pending}
                onToggle={(enabled) => {
                  onToggleTool(tool.name, enabled);
                }}
              />
            ))}
          </div>
        )}
      </TabsContent>
      {capabilities.instructionsSource !== "none" ? (
        <TabsContent value="instructions" className="mt-0">
          {server.instructions === null ||
          server.instructions.trim().length === 0 ? (
            <p className="py-3 text-center text-ui-xs text-muted-foreground">
              No instructions from this server.
            </p>
          ) : (
            <pre
              // muted-fill-ok: weak tint delimited by its own border-border/40
              className="max-h-[min(40vh,20rem)] overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground"
            >
              {server.instructions}
            </pre>
          )}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function ToolsUnavailableState(props: {
  readonly server: ProviderMcpServer;
  readonly onLogin: (() => void) | null;
  readonly onRefresh: (() => void) | null;
  readonly pending: boolean;
}): ReactNode {
  const { server, onLogin, onRefresh, pending } = props;
  let message = "Tools are unavailable until this server is connected.";
  if (server.configOnly) {
    message =
      "This OAuth-gated server is config-only — manage it in the provider's native surface, or sign in if available.";
  } else if (server.stdioDegraded) {
    message =
      "Stdio is degraded for this provider — config is editable, but live tools are unavailable in-session.";
  } else if (server.status === "needs_auth") {
    message = "Sign in to discover tools for this server.";
  } else if (server.status === "error") {
    message =
      server.statusDetail !== null
        ? redactLogText(server.statusDetail)
        : "Connection failed. Retry to discover tools.";
  } else if (server.status === "connecting") {
    message = "Connecting…";
  } else if (!server.enabled) {
    message = "Enable this server to discover tools.";
  }

  const showRetry =
    onRefresh !== null &&
    (server.status === "error" || server.status === "disconnected");

  return (
    <div className="flex flex-col items-start gap-2 py-2">
      <p className="text-ui-xs text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        {server.status === "needs_auth" && onLogin !== null ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onLogin}
          >
            Sign in
          </Button>
        ) : null}
        {showRetry ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={onRefresh}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function denySourceLabel(source: string): string {
  if (source === "user") return "user settings";
  if (source === "shared") return "shared project settings";
  if (source === "local") return "local project settings";
  return source;
}

function toolDenySourceSummary(tool: ProviderMcpTool): string | null {
  const sources = tool.denySources ?? [];
  if (sources.length === 0) return null;
  return sources.map(denySourceLabel).join(", ");
}

function toolAriaLabel(tool: ProviderMcpTool, readOnly: boolean): string {
  const denySummary = toolDenySourceSummary(tool);
  if (readOnly && denySummary !== null) {
    return `${tool.name} (disabled by ${denySummary})`;
  }
  if (readOnly) return tool.name;
  if (tool.enabled) return `Disable tool ${tool.name}`;
  return `Enable tool ${tool.name}`;
}

function ToolChip(props: {
  readonly tool: ProviderMcpTool;
  readonly readOnly: boolean;
  readonly disabled: boolean;
  readonly onToggle: (enabled: boolean) => void;
}): ReactNode {
  const { tool, readOnly, disabled, onToggle } = props;
  const denySummary = toolDenySourceSummary(tool);
  const chipDisabled = disabled || readOnly;
  const chip = (
    <button
      type="button"
      aria-disabled={chipDisabled}
      onClick={() => {
        if (chipDisabled) return;
        onToggle(!tool.enabled);
      }}
      className={cn(
        "w-full truncate rounded-md border border-border/60 px-2.5 py-1.5 text-left text-ui-xs transition-colors",
        tool.enabled
          ? "bg-background text-foreground hover:bg-foreground/5"
          : // muted-fill-ok: the disabled state also carries line-through and
            // border-border/60, so it survives a collapse of the tint
            "bg-muted/20 text-muted-foreground line-through",
        readOnly ? "cursor-default" : "cursor-pointer",
        disabled ? "opacity-60" : null,
      )}
      aria-pressed={tool.enabled}
      aria-label={toolAriaLabel(tool, readOnly)}
    >
      <span className="truncate">{tool.name}</span>
      {denySummary !== null ? (
        <span className="mt-0.5 block truncate text-[0.65rem] font-normal text-muted-foreground no-underline">
          {denySummary}
        </span>
      ) : null}
    </button>
  );

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="block w-full">{chip}</span>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        className="w-[min(90vw,20rem)] max-h-[min(50vh,18rem)] overflow-auto p-3"
      >
        <div className="text-ui-sm font-medium text-foreground">
          {tool.name}
        </div>
        {denySummary !== null ? (
          <p className="mt-1 text-ui-xs text-muted-foreground">
            Disabled by {denySummary}
            {readOnly && denySummary !== "local project settings"
              ? " (locked — clear the deny in that source to re-enable)"
              : null}
          </p>
        ) : null}
        {tool.description !== null && tool.description.length > 0 ? (
          <p className="mt-1 text-ui-xs text-muted-foreground">
            {tool.description}
          </p>
        ) : (
          <p className="mt-1 text-ui-xs text-muted-foreground">
            No description.
          </p>
        )}
        <div className="mt-2 text-ui-xs font-medium text-foreground">
          Input Schema
        </div>
        <ToolSchemaBody schema={tool.inputSchema} />
      </HoverCardContent>
    </HoverCard>
  );
}

function ToolSchemaBody(props: {
  readonly schema: Record<string, unknown> | null;
}): ReactNode {
  if (props.schema === null) {
    return (
      <p className="mt-1 text-ui-xs text-muted-foreground">
        Schema not available.
      </p>
    );
  }
  const properties = props.schema.properties;
  const required = new Set(
    Array.isArray(props.schema.required)
      ? props.schema.required.filter((v): v is string => typeof v === "string")
      : [],
  );
  if (
    properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const entries = Object.entries(properties as Record<string, unknown>);
    if (entries.length === 0) {
      return (
        <p className="mt-1 text-ui-xs text-muted-foreground">No properties.</p>
      );
    }
    return (
      <ul className="mt-1 flex flex-col gap-1">
        {entries.map(([name, value]) => {
          const desc =
            value !== null &&
            typeof value === "object" &&
            "description" in value &&
            typeof value.description === "string"
              ? value.description
              : null;
          const isRequired = required.has(name);
          return (
            <li key={name} className="text-ui-xs text-muted-foreground">
              <span className="font-medium text-foreground">{name}</span>
              {isRequired ? <span className="text-destructive"> *</span> : null}
              {desc !== null ? ` — ${desc}` : null}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <pre className="mt-1 max-h-[min(30vh,12rem)] overflow-auto whitespace-pre-wrap text-ui-xs text-muted-foreground">
      {JSON.stringify(props.schema, null, 2)}
    </pre>
  );
}

function statusDotClass(
  status: ProviderMcpServerStatus,
  pending: boolean,
): string {
  if (pending || status === "connecting")
    return "animate-pulse bg-amber-500 dark:bg-amber-400";
  if (status === "connected") return "bg-emerald-500 dark:bg-emerald-400";
  if (status === "needs_auth" || status === "error") return "bg-destructive";
  return "bg-muted-foreground/50";
}

function StatusDot(props: {
  readonly status: ProviderMcpServerStatus;
  readonly pending: boolean;
}): ReactNode {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        statusDotClass(props.status, props.pending),
      )}
    />
  );
}

function statusLabelFor(server: ProviderMcpServer): string {
  if (server.discoveryPending || server.status === "connecting") {
    return "Connecting…";
  }
  if (!server.enabled) return "Disabled";
  switch (server.status) {
    case "connected":
      return server.statusSource === "probe" ? "Reachable" : "Connected";
    case "needs_auth":
      return "Needs auth";
    case "error":
      return "Error";
    case "disconnected":
      return "Disconnected";
    case "config_only":
      return "Config only";
    case "unknown":
      return "Unknown";
  }
}
