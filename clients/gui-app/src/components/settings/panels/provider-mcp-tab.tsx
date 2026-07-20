import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  LogIn,
  LogOut,
  Pencil,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useProvidersMcpList } from "@/hooks/providers/use-providers-mcp-list-query";
import { useProvidersMcpMutate } from "@/hooks/providers/use-providers-mcp-mutate-mutation";
import { useProvidersMcpDiscover } from "@/hooks/providers/use-providers-mcp-discover-mutation";
import { useProvidersMcpAuth } from "@/hooks/providers/use-providers-mcp-auth-mutation";
import { isProviderNativeRpcError } from "@/hooks/providers/native-response-map";
import { useRunnerOpenExternalLink } from "@/hooks/runner/use-open-external-link-mutation";
import { useResolvedWorkspaceFolders } from "@/hooks/workspace/use-resolved-workspace-folders-query";
import { useHostBinding } from "@/lib/host";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";
import { redactLogText } from "@/lib/logger";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { cn } from "@/lib/utils";
import type { McpPendingAuthEntry } from "@/stores/settings/mcp-pending-auth-store";
import { useMcpPendingAuthStore } from "@/stores/settings/mcp-pending-auth-store";
import { useProvidersWorkspaceSelectionStore } from "@/stores/settings/providers-workspace-selection-store";
import { useWorkspaceFoldersStore } from "@/stores/workspace/workspace-folders-store";
import { ProviderMcpAddDialog } from "./provider-mcp-add-dialog";

const EMPTY_MCP_SERVERS: readonly ProviderMcpServer[] = [];

function resolveLockedScope(
  supportsProject: boolean,
  supportsGlobal: boolean,
): ProviderNativeScope {
  if (supportsProject && !supportsGlobal) return "project";
  return "global";
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
    const server = byName.get(name);
    if (server === undefined) continue;
    if (server.status === "connecting" || server.status === "needs_auth") {
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
  const canUpdate = scopes.update.includes(effectiveScope);
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
    canUpdate,
    canToggleServer,
    canDiscover,
    canAuth,
    toolsReadOnly,
  };
}

function useMcpScope(capabilities: ProviderMcpCapabilities) {
  const hostId = useReactiveActiveHostId();
  // Prefer the runtime binding when present; null is valid (tests / host-less
  // shells) and falls through to local-only resolution.
  const binding = useHostBinding();
  const client = binding?.hostClient ?? null;
  const folders = useWorkspaceFoldersStore((s) => s.folders);
  const folderInfoByPath = useWorkspaceFoldersStore((s) => s.folderInfoByPath);
  const folderSource = useMemo(
    () => ({ folders, folderInfoByPath }),
    [folders, folderInfoByPath],
  );
  const selectedByHostId = useProvidersWorkspaceSelectionStore(
    (s) => s.selectedByHostId,
  );
  const setSelected = useProvidersWorkspaceSelectionStore((s) => s.setSelected);

  // Resolve against the HostRuntimeContext-bound host so paths from another
  // machine never become Project workspaceRoot for this host (B6).
  const resolved = useResolvedWorkspaceFolders(folderSource, client);
  const workspaces = useMemo(
    () =>
      resolved.folders
        .filter((folder) => folder.kind !== "unresolved")
        .map((folder) => ({
          path: folder.path,
          name:
            folder.name.length > 0
              ? folder.name
              : workspaceFolderName(folder.path),
        })),
    [resolved.folders],
  );
  const hostPaths = useMemo(
    () => workspaces.map((ws) => ws.path),
    [workspaces],
  );

  const selected = hostId === null ? undefined : selectedByHostId[hostId];
  const selectedValid =
    selected !== undefined && hostPaths.includes(selected) ? selected : null;

  let workspaceRoot: string | null = null;
  if (selectedValid !== null) {
    workspaceRoot = selectedValid;
  } else if (hostPaths.length === 1) {
    workspaceRoot = hostPaths[0];
  }

  const workspaceName =
    workspaceRoot === null
      ? null
      : (workspaces.find((w) => w.path === workspaceRoot)?.name ??
        workspaceFolderName(workspaceRoot));

  const setWorkspaceRoot = useCallback(
    (path: string) => {
      if (hostId === null) return;
      setSelected(hostId, path);
    },
    [hostId, setSelected],
  );

  const multiWorkspace = hostPaths.length > 1;

  const listScopes = capabilities.actionScopes.list;
  const supportsGlobal = listScopes.includes("global");
  const supportsProject = listScopes.includes("project");
  const multiScope = supportsGlobal && supportsProject;
  const lockedScope = resolveLockedScope(supportsProject, supportsGlobal);

  const [scope, setScope] = useState<ProviderNativeScope>(lockedScope);
  const effectiveScope: ProviderNativeScope = multiScope ? scope : lockedScope;

  const projectNeedsWorkspace =
    effectiveScope === "project" && workspaceRoot === null;
  const listWorkspaceRoot = effectiveScope === "global" ? null : workspaceRoot;
  // Project is only fully disabled when this host has zero resolvable
  // workspaces. Multi with no selection still enables Project so the picker
  // can be shown for first-use.
  const projectDisabled = hostPaths.length === 0 && !resolved.isLoading;

  return {
    hostId,
    workspaces,
    workspaceRoot,
    workspaceName,
    setWorkspaceRoot,
    multiWorkspace,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    projectDisabled,
    listWorkspaceRoot,
    listEnabled: !projectNeedsWorkspace,
    workspacesLoading: resolved.isLoading,
  };
}

export function ProviderMcpTab(props: {
  readonly providerId: ProviderId;
  readonly capabilities: ProviderMcpCapabilities;
  readonly providerLabel: string;
}): ReactNode {
  const { providerId, capabilities, providerLabel } = props;
  const scopeState = useMcpScope(capabilities);
  const {
    hostId,
    workspaces,
    workspaceRoot,
    workspaceName,
    setWorkspaceRoot,
    multiWorkspace,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    projectDisabled,
    listWorkspaceRoot,
    listEnabled,
    workspacesLoading,
  } = scopeState;

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderMcpServer | null>(null);
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

  const servers = listQuery.data?.servers ?? EMPTY_MCP_SERVERS;

  // Adjust auth-awaiting set from latest list data during render (React
  // "storing information from previous renders" pattern) — avoids setState
  // inside an effect.
  const prunedAuthAwaiting = pruneAuthAwaiting(authAwaitingNames, servers);
  if (prunedAuthAwaiting !== authAwaitingNames) {
    const settled = [...authAwaitingNames].filter(
      (name) => !prunedAuthAwaiting.has(name),
    );
    for (const name of settled) {
      pendingAuthRemove({
        providerId,
        scope: effectiveScope,
        workspaceRoot: listWorkspaceRoot,
        serverName: name,
      });
    }
    setAuthAwaitingNames(prunedAuthAwaiting);
  }

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
    canUpdate,
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

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setAddOpen(false);
      setEditTarget(null);
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

  const dialogOpen = addOpen || editTarget !== null;
  const dialogMode = editTarget !== null ? "edit" : "add";

  return (
    <div className="flex flex-col gap-3" data-testid="provider-mcp-tab">
      <McpScopeHeader
        multiScope={multiScope}
        effectiveScope={effectiveScope}
        canAdd={canAdd}
        projectNeedsWorkspace={projectNeedsWorkspace}
        projectDisabled={projectDisabled}
        onScopeChange={setScope}
        onAdd={() => {
          setEditTarget(null);
          setAddOpen(true);
        }}
      />

      {effectiveScope === "project" ? (
        <ProjectWorkspacePicker
          multiWorkspace={multiWorkspace}
          workspaceRoot={workspaceRoot}
          workspaceName={workspaceName}
          workspaces={workspaces}
          onWorkspaceRootChange={setWorkspaceRoot}
        />
      ) : null}

      <McpCapabilityNotices
        capabilities={capabilities}
        authInstruction={authInstruction}
      />

      <McpServerList
        projectNeedsWorkspace={projectNeedsWorkspace}
        multiWorkspace={multiWorkspace}
        workspacesLoading={workspacesLoading}
        listPending={listQuery.isPending}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        servers={servers}
        providerLabel={providerLabel}
        capabilities={capabilities}
        shadowedNames={shadowedNames}
        pendingServerNames={pendingServerNames}
        rowErrors={rowErrors}
        canRemove={canRemove}
        canUpdate={canUpdate}
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
        onEdit={(server) => {
          setAddOpen(false);
          setEditTarget(server);
        }}
        onDelete={setDeleteTarget}
      />

      <ProviderMcpAddDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        mode={dialogMode}
        initialServer={editTarget}
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

function ProjectWorkspacePicker(props: {
  readonly multiWorkspace: boolean;
  readonly workspaceRoot: string | null;
  readonly workspaceName: string | null;
  readonly workspaces: readonly {
    readonly path: string;
    readonly name: string;
  }[];
  readonly onWorkspaceRootChange: (value: string) => void;
}): ReactNode {
  const {
    multiWorkspace,
    workspaceRoot,
    workspaceName,
    workspaces,
    onWorkspaceRootChange,
  } = props;
  if (multiWorkspace) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-xs text-muted-foreground">Project:</span>
        <Select
          value={workspaceRoot ?? undefined}
          onValueChange={onWorkspaceRootChange}
        >
          <SelectTrigger
            className="h-8 w-[min(90vw,16rem)]"
            aria-label="Project workspace"
          >
            <SelectValue placeholder="Select workspace" />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((ws) => (
              <SelectItem key={ws.path} value={ws.path}>
                {ws.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  if (workspaceRoot !== null) {
    return (
      <p className="text-ui-xs text-muted-foreground">
        Project:{" "}
        <span className="font-medium text-foreground">{workspaceName}</span>
      </p>
    );
  }
  return null;
}

function McpScopeHeader(props: {
  readonly multiScope: boolean;
  readonly effectiveScope: ProviderNativeScope;
  readonly canAdd: boolean;
  readonly projectNeedsWorkspace: boolean;
  readonly projectDisabled: boolean;
  readonly onScopeChange: (scope: ProviderNativeScope) => void;
  readonly onAdd: () => void;
}): ReactNode {
  const scopeOnlyLabel =
    props.effectiveScope === "global"
      ? "Global scope only"
      : "Project scope only";

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {props.multiScope ? (
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5">
          <ScopeChip
            label="Global"
            active={props.effectiveScope === "global"}
            disabled={false}
            title={null}
            onClick={() => {
              props.onScopeChange("global");
            }}
          />
          <ScopeChip
            label="Project"
            active={props.effectiveScope === "project"}
            disabled={props.projectDisabled}
            title={props.projectDisabled ? "Open a workspace first" : null}
            onClick={() => {
              props.onScopeChange("project");
            }}
          />
        </div>
      ) : (
        <p className="text-ui-xs text-muted-foreground">{scopeOnlyLabel}</p>
      )}
      {props.canAdd && !props.projectNeedsWorkspace ? (
        <Button type="button" size="sm" variant="outline" onClick={props.onAdd}>
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
}): ReactNode {
  return (
    <>
      {props.capabilities.traycerSessionsOnlyEnforcement ? (
        <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground">
          Tool enable/disable applies to Traycer sessions only for this
          provider.
        </p>
      ) : null}
      {props.capabilities.stdioDegradeNotice ? (
        <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground">
          Stdio servers are config-only under this provider — live connect is
          unavailable in-session.
        </p>
      ) : null}
      {props.authInstruction !== null ? (
        <p className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground">
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
  readonly servers: readonly ProviderMcpServer[];
  readonly providerLabel: string;
  readonly capabilities: ProviderMcpCapabilities;
  readonly shadowedNames: ReadonlySet<string>;
  readonly pendingServerNames: ReadonlySet<string>;
  readonly rowErrors: ReadonlyMap<string, string>;
  readonly canRemove: boolean;
  readonly canUpdate: boolean;
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
  readonly onEdit: (server: ProviderMcpServer) => void;
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
        />
      );
    }
    return (
      <EmptyState
        title="Open a workspace"
        description="Open a workspace on this host to manage project-scoped MCP servers."
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
      />
    );
  }
  if (props.servers.length === 0) {
    return (
      <EmptyState
        title="No MCP servers"
        description={`Add an MCP server so ${props.providerLabel} can use external tools and context.`}
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
          canUpdate={props.canUpdate}
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
          onEdit={() => {
            props.onEdit(server);
          }}
          onDelete={() => {
            props.onDelete(server.name);
          }}
        />
      ))}
    </ul>
  );
}

function ScopeChip(props: {
  readonly label: string;
  readonly active: boolean;
  readonly disabled: boolean;
  readonly title: string | null;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title ?? undefined}
      aria-pressed={props.active}
      className={cn(
        "inline-flex items-center rounded-sm px-3 py-1 text-ui-sm transition-colors",
        props.active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        props.disabled
          ? "cursor-not-allowed opacity-50 hover:text-muted-foreground"
          : null,
      )}
    >
      {props.label}
    </button>
  );
}

function EmptyState(props: {
  readonly title: string;
  readonly description: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
      <div className="text-ui-sm font-medium text-foreground">
        {props.title}
      </div>
      <p className="text-ui-xs text-muted-foreground">{props.description}</p>
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
  readonly canUpdate: boolean;
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
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const {
    server,
    capabilities,
    shadowed,
    pending,
    rowError,
    canRemove,
    canUpdate,
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
    onEdit,
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
            canUpdate={canUpdate}
            canToggleServer={canToggleServer}
            canDiscover={canDiscover}
            onLogin={onLogin}
            onLogout={onLogout}
            onForceReauth={onForceReauth}
            onRefresh={onRefresh}
            onEdit={onEdit}
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
  readonly canUpdate: boolean;
  readonly canToggleServer: boolean;
  readonly canDiscover: boolean;
  readonly onLogin: () => void;
  readonly onLogout: () => void;
  readonly onForceReauth: () => void;
  readonly onRefresh: () => void;
  readonly onEdit: () => void;
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
      {props.canUpdate ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled={props.pending}
          onClick={props.onEdit}
          aria-label={`Edit ${props.serverName}`}
        >
          <Pencil className="size-3.5" />
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
          <div className="ml-auto flex gap-2 text-ui-xs text-muted-foreground">
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
            <pre className="max-h-[min(40vh,20rem)] overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
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
          ? "bg-background text-foreground hover:bg-muted/40"
          : "bg-muted/20 text-muted-foreground line-through",
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
