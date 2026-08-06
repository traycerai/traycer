import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
  ProviderNativeScope,
  ProviderPlugin,
  ProviderPluginsCapabilities,
  ProvidersPluginsMutateAction,
} from "@traycer/protocol/host/provider-native-schemas";
import { Package, Plus, Trash2 } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useProvidersPluginIcon } from "@/hooks/providers/use-providers-plugin-icon-query";
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";
import { useProvidersPluginsMutate } from "@/hooks/providers/use-providers-plugins-mutate-mutation";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { cn } from "@/lib/utils";
import { ProviderEntryIcon } from "./provider-entry-icon";
import {
  filterProviderPlugins,
  isProviderListSearchActive,
} from "./provider-list-search-filter";
import {
  ProviderListSearch,
  ProviderListSearchEmptyState,
} from "./provider-list-search";
import {
  McpScopePicker,
  type McpScopeTarget,
} from "./provider-mcp-scope-picker";
import { useProviderNativeScope } from "./use-provider-native-scope";

const EMPTY_PLUGINS: readonly ProviderPlugin[] = [];

/**
 * Shown for every provider whose contract sets `traycerSessionToolsNotice`
 * (amp and cursor today). There used to be two strings selected by
 * `providerId === "cursor"`, which was the tail of a redundancy: cursor's
 * contract ALREADY sets the flag (`contract-registry/cursor.ts`), so the id
 * arms could never change what rendered - only which sentence did. Two
 * sentences for one flag is how the flag stops being the thing that decides,
 * and the next provider to set it would have got amp's copy anyway.
 *
 * The wording is the union of what both said that the user can act on. Cursor's
 * old copy also asserted "listing is read-only", which its `addModes:
 * ["read-only"]` already renders on screen without being told.
 */
const SESSION_TOOLS_NOTICE =
  "Plugin tools may not appear in Traycer-launched sessions. They load for this provider's own CLI, but not for the session stream Traycer drives.";

export function ProviderPluginsTab({
  state,
}: {
  readonly state: ProviderCliState;
}): ReactNode {
  const caps = state.nativeCapabilities.plugins;
  if (caps === null) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
        <div className="text-ui-sm font-medium text-foreground">Plugins</div>
        <p className="text-ui-xs text-muted-foreground">
          This provider does not support plugins.
        </p>
      </div>
    );
  }

  return <ProviderPluginsTabBody providerId={state.providerId} caps={caps} />;
}

function pluginCapabilityFlags(
  caps: ProviderPluginsCapabilities,
  effectiveScope: ProviderNativeScope,
) {
  const writableModes = caps.addModes.some(
    (m) =>
      m === "cli-source" ||
      m === "marketplace" ||
      m === "file-drop" ||
      m === "patch",
  );
  // Per-scope gates match the MCP tab: a verb advertised only for global must
  // not appear while the user is viewing project (and vice versa).
  const canRemove = caps.actionScopes.remove.includes(effectiveScope);
  const canEnableDisable =
    caps.actionScopes.setEnabled.includes(effectiveScope);
  const canAddAtScope = caps.actionScopes.add.includes(effectiveScope);
  const isReadOnly =
    caps.addModes.length === 0 ||
    (caps.addModes.length === 1 && caps.addModes[0] === "read-only") ||
    (!canRemove && !canEnableDisable && !(writableModes && canAddAtScope));
  const canAdd = !isReadOnly && writableModes && canAddAtScope;
  return { isReadOnly, canAdd, canRemove, canEnableDisable };
}

function PluginsNotices(props: {
  readonly sessionNotice: string | null;
  readonly reloadHint: boolean;
  readonly localError: string | null;
}): ReactNode {
  return (
    <>
      {props.sessionNotice !== null ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-700 dark:text-amber-200">
          {props.sessionNotice}
        </div>
      ) : null}
      {props.reloadHint ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-ui-xs text-muted-foreground">
          Plugin changes applied. Restart the provider agent for them to take
          effect in active sessions.
        </div>
      ) : null}
      {props.localError !== null ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          {props.localError}
        </div>
      ) : null}
    </>
  );
}

function PluginsScopeToolbar(props: {
  readonly multiScope: boolean;
  readonly effectiveScope: ProviderNativeScope;
  readonly targets: readonly McpScopeTarget[];
  readonly workspaceRoot: string | null;
  readonly workspacesLoading: boolean;
  readonly browsePending: boolean;
  readonly canAdd: boolean;
  readonly projectNeedsWorkspace: boolean;
  readonly isMutating: boolean;
  readonly onBrowse: () => void;
  readonly onScopeChange: (scope: ProviderNativeScope) => void;
  readonly onWorkspaceRootChange: (path: string) => void;
  readonly onToggleAdd: () => void;
}): ReactNode {
  // Same wording as the MCP tab: a global-only contract gets a plain statement
  // rather than a picker holding one dead option.
  const globalOnly = !props.multiScope && props.effectiveScope === "global";
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
          locationLabel="Plugins location"
          onBrowse={props.onBrowse}
          onSelectGlobal={() => {
            props.onScopeChange("global");
          }}
          onSelectProject={(path) => {
            props.onWorkspaceRootChange(path);
            props.onScopeChange("project");
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {props.canAdd && !props.projectNeedsWorkspace ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-ui-xs"
            disabled={props.isMutating}
            onClick={props.onToggleAdd}
          >
            <Plus className="size-3.5" />
            Add from source
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProviderPluginsTabBody({
  providerId,
  caps,
}: {
  readonly providerId: ProviderId;
  readonly caps: ProviderPluginsCapabilities;
}): ReactNode {
  const scopeState = useProviderNativeScope(caps.actionScopes.list);
  const {
    targets,
    workspaceRoot,
    setWorkspaceRoot,
    browseForWorkspace,
    browsePending,
    multiScope,
    effectiveScope,
    setScope,
    projectNeedsWorkspace,
    listWorkspaceRoot,
    listEnabled,
    workspacesLoading,
  } = scopeState;
  const { isReadOnly, canAdd } = pluginCapabilityFlags(caps, effectiveScope);

  const listQuery = useProvidersPluginsList({
    providerId,
    scope: effectiveScope,
    workspaceRoot: listWorkspaceRoot,
    enabled: listEnabled,
  });
  const mutate = useProvidersPluginsMutate();

  const [sourceDraft, setSourceDraft] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reloadHint, setReloadHint] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProviderPlugin | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const plugins = listQuery.data?.plugins ?? EMPTY_PLUGINS;
  const filteredPlugins = useMemo(
    () => filterProviderPlugins(plugins, searchQuery),
    [plugins, searchQuery],
  );
  const pluginSearchActive = isProviderListSearchActive(searchQuery);
  const isMutating = pendingIds.size > 0 || mutate.isPending;
  const removeDialogPending =
    removeTarget !== null && pendingIds.has(removeTarget.id);

  const sessionNotice = sessionNoticeFor(caps);
  const showAdd = canAdd && !projectNeedsWorkspace;

  const handleBrowse = useCallback(() => {
    void browseForWorkspace()
      .then((path) => {
        if (path === null) return;
        setWorkspaceRoot(path);
        setScope("project");
      })
      .catch(() => {
        reportableErrorToast("Couldn't open the folder picker.", undefined, {
          title: "Could not add workspace folders",
          message: "The folder picker failed to open.",
          code: null,
          source: "Workspace folders",
        });
      });
  }, [browseForWorkspace, setScope, setWorkspaceRoot]);

  const markPending = useCallback((trackId: string, pending: boolean): void => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(trackId);
      else next.delete(trackId);
      return next;
    });
  }, []);

  const runMutation = useCallback(
    (mutation: ProvidersPluginsMutateAction, trackId: string | null): void => {
      setLocalError(null);
      if (trackId !== null) markPending(trackId, true);
      mutate.mutate(
        {
          providerId,
          scope: effectiveScope,
          workspaceRoot: listWorkspaceRoot,
          mutation,
          // This surface renders the failure inline via `setLocalError` below,
          // so the hook's global toast would double-report the same error.
          suppressToast: true,
        },
        {
          onSuccess: () => {
            if (trackId !== null) markPending(trackId, false);
            setReloadHint(true);
            setSourceDraft("");
            setAddOpen(false);
            setRemoveTarget(null);
          },
          onError: (err) => {
            if (trackId !== null) markPending(trackId, false);
            setLocalError(err.message);
          },
        },
      );
    },
    [effectiveScope, listWorkspaceRoot, markPending, mutate, providerId],
  );

  return (
    <div className="flex flex-col gap-3">
      {/*
       * `sessionNotice` is now the whole gate: `sessionNoticeFor` returns null
       * unless the contract sets `traycerSessionToolsNotice`, so the separate
       * `showSessionNotice` flag (which also special-cased cursor by id) would
       * only re-ask a question the notice already answers.
       */}
      <PluginsNotices
        sessionNotice={sessionNotice}
        reloadHint={reloadHint}
        localError={localError}
      />

      <PluginsScopeToolbar
        multiScope={multiScope}
        effectiveScope={effectiveScope}
        targets={targets}
        workspaceRoot={workspaceRoot}
        workspacesLoading={workspacesLoading}
        browsePending={browsePending}
        canAdd={canAdd}
        projectNeedsWorkspace={projectNeedsWorkspace}
        isMutating={isMutating}
        onBrowse={handleBrowse}
        onScopeChange={setScope}
        onWorkspaceRootChange={setWorkspaceRoot}
        onToggleAdd={() => {
          setAddOpen((v) => !v);
        }}
      />

      {addOpen && showAdd ? (
        <PluginAddFromSource
          sourceDraft={sourceDraft}
          setSourceDraft={setSourceDraft}
          pendingIds={pendingIds}
          runMutation={runMutation}
        />
      ) : null}

      {!projectNeedsWorkspace ? (
        <ProviderListSearch
          query={searchQuery}
          onQueryChange={setSearchQuery}
          resultCount={filteredPlugins.length}
          resourceLabel="plugins"
        />
      ) : null}

      <PluginsListBody
        providerId={providerId}
        scope={effectiveScope}
        workspaceRoot={listWorkspaceRoot}
        projectNeedsWorkspace={projectNeedsWorkspace}
        workspacesLoading={workspacesLoading}
        listLoading={listQuery.isLoading || listQuery.isPending}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        plugins={filteredPlugins}
        unfilteredPluginCount={plugins.length}
        searchQuery={searchQuery}
        searchActive={pluginSearchActive}
        isReadOnly={isReadOnly}
        caps={caps}
        effectiveScope={effectiveScope}
        pendingIds={pendingIds}
        runMutation={runMutation}
        onRequestRemove={setRemoveTarget}
      />

      <ConfirmDestructiveDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove plugin"
        description={
          removeTarget === null
            ? ""
            : `Remove “${removeTarget.name}” from this provider?`
        }
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={removeDialogPending}
        onConfirm={() => {
          if (removeTarget === null) return;
          runMutation(
            { action: "remove", id: removeTarget.id },
            removeTarget.id,
          );
        }}
      />
    </div>
  );
}

function sessionNoticeFor(caps: ProviderPluginsCapabilities): string | null {
  return caps.traycerSessionToolsNotice ? SESSION_TOOLS_NOTICE : null;
}

function PluginAddFromSource({
  sourceDraft,
  setSourceDraft,
  pendingIds,
  runMutation,
}: {
  readonly sourceDraft: string;
  readonly setSourceDraft: (v: string) => void;
  readonly pendingIds: ReadonlySet<string>;
  readonly runMutation: (
    mutation: ProvidersPluginsMutateAction,
    trackId: string | null,
  ) => void;
}): ReactNode {
  const trackId = sourceDraft.trim();
  const pending = trackId.length > 0 && pendingIds.has(trackId);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 p-3">
      <label
        className="text-ui-xs text-muted-foreground"
        htmlFor="plugin-source"
      >
        Source (npm package, path, git URL, or plugin@marketplace)
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="plugin-source"
          value={sourceDraft}
          onChange={(e) => setSourceDraft(e.target.value)}
          placeholder="plugin@marketplace or /path/to/plugin"
          className="min-w-0 flex-1 text-ui-xs"
          disabled={pending}
        />
        <Button
          type="button"
          size="sm"
          disabled={pending || trackId.length === 0}
          onClick={() =>
            runMutation({ action: "add", source: trackId }, trackId)
          }
        >
          {pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
          Install
        </Button>
      </div>
    </div>
  );
}

function PluginsListBody({
  providerId,
  scope,
  workspaceRoot,
  projectNeedsWorkspace,
  workspacesLoading,
  listLoading,
  listError,
  errorMessage,
  plugins,
  unfilteredPluginCount,
  searchQuery,
  searchActive,
  isReadOnly,
  caps,
  effectiveScope,
  pendingIds,
  runMutation,
  onRequestRemove,
}: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly projectNeedsWorkspace: boolean;
  readonly workspacesLoading: boolean;
  readonly listLoading: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly plugins: readonly ProviderPlugin[];
  readonly unfilteredPluginCount: number;
  readonly searchQuery: string;
  readonly searchActive: boolean;
  readonly isReadOnly: boolean;
  readonly caps: ProviderPluginsCapabilities;
  readonly effectiveScope: ProviderNativeScope;
  readonly pendingIds: ReadonlySet<string>;
  readonly runMutation: (
    mutation: ProvidersPluginsMutateAction,
    trackId: string | null,
  ) => void;
  readonly onRequestRemove: (plugin: ProviderPlugin) => void;
}): ReactNode {
  if (projectNeedsWorkspace) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border border-border/60 p-4">
        <div className="text-ui-sm font-medium text-foreground">
          {workspacesLoading ? "Resolving workspaces…" : "Select a workspace"}
        </div>
        <p className="text-ui-xs text-muted-foreground">
          {workspacesLoading
            ? "Resolving workspaces on this host."
            : "Choose a project workspace above to manage project-scoped plugins on this host."}
        </p>
      </div>
    );
  }
  if (listLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-ui-xs text-muted-foreground">
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
        Loading plugins…
      </div>
    );
  }
  if (listError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
        {errorMessage}
      </div>
    );
  }
  if (unfilteredPluginCount === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-8 text-center">
        <Package className="size-5 text-muted-foreground" />
        <p className="text-ui-xs text-muted-foreground">
          {isReadOnly
            ? "No plugins installed."
            : "No plugins installed yet. Add one from a source or marketplace."}
        </p>
      </div>
    );
  }
  if (searchActive && plugins.length === 0) {
    return (
      <ProviderListSearchEmptyState
        query={searchQuery}
        resourceLabel="plugins"
      />
    );
  }
  // A list-level decision, not a per-row one: the icon column is reserved for
  // every row as soon as ANY row has artwork, so the names keep one left edge.
  // For a provider that ships no plugin icons at all this is false everywhere
  // and the column simply does not exist.
  const reserveIconSpace = plugins.some((plugin) => plugin.hasIcon === true);
  return (
    <ul className="flex flex-col gap-2">
      {plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          providerId={providerId}
          scope={scope}
          workspaceRoot={workspaceRoot}
          plugin={plugin}
          caps={caps}
          effectiveScope={effectiveScope}
          isReadOnly={isReadOnly || plugin.readOnly}
          pending={pendingIds.has(plugin.id)}
          reserveIconSpace={reserveIconSpace}
          onToggle={(enabled) =>
            runMutation(
              { action: "setEnabled", id: plugin.id, enabled },
              plugin.id,
            )
          }
          onRemove={() => {
            onRequestRemove(plugin);
          }}
        />
      ))}
    </ul>
  );
}

function PluginRow({
  providerId,
  scope,
  workspaceRoot,
  plugin,
  caps,
  effectiveScope,
  isReadOnly,
  pending,
  reserveIconSpace,
  onToggle,
  onRemove,
}: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly plugin: ProviderPlugin;
  readonly caps: ProviderPluginsCapabilities;
  readonly effectiveScope: ProviderNativeScope;
  readonly isReadOnly: boolean;
  readonly pending: boolean;
  /** Some row in this list has artwork, so keep the text column aligned. */
  readonly reserveIconSpace: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const canRemove = caps.actionScopes.remove.includes(effectiveScope);
  const canEnableDisable =
    caps.actionScopes.setEnabled.includes(effectiveScope);
  const sourceBadge = plugin.source ?? null;
  // Gated on the list's own `hasIcon`, so rows with no artwork never make the
  // request. Per row rather than batched: each resolves independently and the
  // list renders immediately without waiting on the slowest image.
  const iconQuery = useProvidersPluginIcon({
    providerId,
    scope,
    workspaceRoot,
    pluginId: plugin.id,
    // Cache identity, not a request field: an upgrade installed outside the
    // app arrives on this list, and without it here the icon query - which is
    // `staleTime: Infinity`, `poll: false` - would serve the old version's
    // artwork for the rest of the session.
    version: plugin.version,
    hasDarkIcon: plugin.hasDarkIcon === true,
    enabled: plugin.hasIcon === true,
  });
  // `displayName` is the provider's own label ("PDF"); `name` is the install
  // id ("pdf"). Older hosts send neither field, hence the fallback.
  const title = plugin.displayName ?? plugin.name;
  return (
    <li
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2",
        pending && "opacity-70",
      )}
    >
      {/* Icon column first, name/description second, controls last - the
          three-column rhythm of a plugin manager. Absent for providers that
          ship no plugin artwork, which is most of them. */}
      <ProviderEntryIcon
        iconUrl={iconQuery.data?.icon.dataUri ?? null}
        reserveSpace={reserveIconSpace}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {title}
          </span>
          {plugin.version !== null ? (
            <span className="text-ui-xs text-muted-foreground">
              {plugin.version}
            </span>
          ) : null}
          {sourceBadge !== null ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
              {sourceBadge}
            </span>
          ) : null}
          {pending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </div>
        {(plugin.description ?? "").length > 0 ? (
          <p className="truncate text-ui-xs text-muted-foreground">
            {plugin.description}
          </p>
        ) : (
          <div className="truncate text-ui-xs text-muted-foreground">
            {plugin.id}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {canEnableDisable && !isReadOnly ? (
          <Switch
            checked={plugin.enabled}
            disabled={pending}
            onCheckedChange={onToggle}
            aria-label={
              plugin.enabled
                ? `Disable ${plugin.name}`
                : `Enable ${plugin.name}`
            }
          />
        ) : null}
        {canRemove && !isReadOnly ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={pending}
            onClick={onRemove}
            aria-label={`Remove ${plugin.name}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}
