import { useState, type ReactNode } from "react";
import type {
  ProviderCliState,
  ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type {
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
import { useProvidersPluginsList } from "@/hooks/providers/use-providers-plugins-list-query";
import { useProvidersPluginsMutate } from "@/hooks/providers/use-providers-plugins-mutate-mutation";
import { cn } from "@/lib/utils";

const CURSOR_SESSION_NOTICE =
  "Cursor marketplace plugins are not yet active in Traycer sessions. Listing is read-only until settingSources includes plugins.";

const AMP_SESSION_NOTICE =
  "Plugin tools may not appear in Traycer-launched sessions (they load for CLI tools/plugins list but not the execute stream).";

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

function pluginCapabilityFlags(caps: ProviderPluginsCapabilities) {
  const writableModes = caps.addModes.some(
    (m) =>
      m === "cli-source" ||
      m === "marketplace" ||
      m === "file-drop" ||
      m === "patch",
  );
  const canRemove = caps.actionScopes.remove.length > 0;
  const canEnableDisable = caps.actionScopes.setEnabled.length > 0;
  const isReadOnly =
    caps.addModes.length === 0 ||
    (caps.addModes.length === 1 && caps.addModes[0] === "read-only") ||
    (!canRemove && !canEnableDisable && !writableModes);
  const canAdd = !isReadOnly && writableModes;
  return { isReadOnly, canAdd, canRemove, canEnableDisable };
}

function ProviderPluginsTabBody({
  providerId,
  caps,
}: {
  readonly providerId: ProviderId;
  readonly caps: ProviderPluginsCapabilities;
}): ReactNode {
  const { isReadOnly, canAdd } = pluginCapabilityFlags(caps);
  const showSessionNotice =
    caps.traycerSessionToolsNotice || providerId === "cursor";

  const listQuery = useProvidersPluginsList({
    providerId,
    scope: "global",
    workspaceRoot: null,
    enabled: true,
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

  const plugins = listQuery.data?.plugins ?? [];
  const isMutating = pendingIds.size > 0 || mutate.isPending;
  const removeDialogPending =
    removeTarget !== null && pendingIds.has(removeTarget.id);

  const sessionNotice = sessionNoticeFor(providerId, caps);

  function markPending(trackId: string, pending: boolean): void {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (pending) next.add(trackId);
      else next.delete(trackId);
      return next;
    });
  }

  function runMutation(
    mutation: ProvidersPluginsMutateAction,
    trackId: string | null,
  ): void {
    setLocalError(null);
    if (trackId !== null) markPending(trackId, true);
    mutate.mutate(
      {
        providerId,
        scope: "global",
        workspaceRoot: null,
        mutation,
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
  }

  return (
    <div className="flex flex-col gap-3">
      {showSessionNotice && sessionNotice !== null ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui-xs text-amber-700 dark:text-amber-200">
          {sessionNotice}
        </div>
      ) : null}

      {reloadHint ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-ui-xs text-muted-foreground">
          Plugin changes applied. Restart the provider agent for them to take
          effect in active sessions.
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-ui-xs text-muted-foreground">
          Installed plugins
        </span>
        <div className="flex flex-wrap gap-2">
          {canAdd ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-ui-xs"
              disabled={isMutating}
              onClick={() => {
                setAddOpen((v) => !v);
              }}
            >
              <Plus className="size-3.5" />
              Add from source
            </Button>
          ) : null}
        </div>
      </div>

      {addOpen && canAdd ? (
        <PluginAddFromSource
          sourceDraft={sourceDraft}
          setSourceDraft={setSourceDraft}
          pendingIds={pendingIds}
          runMutation={runMutation}
        />
      ) : null}

      {localError !== null ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          {localError}
        </div>
      ) : null}

      <PluginsListBody
        listLoading={listQuery.isLoading || listQuery.isPending}
        listError={listQuery.isError}
        errorMessage={listQuery.isError ? listQuery.error.message : null}
        plugins={plugins}
        isReadOnly={isReadOnly}
        caps={caps}
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

function sessionNoticeFor(
  providerId: ProviderId,
  caps: ProviderPluginsCapabilities,
): string | null {
  if (providerId === "cursor") return CURSOR_SESSION_NOTICE;
  if (providerId === "amp") return AMP_SESSION_NOTICE;
  if (caps.traycerSessionToolsNotice) return AMP_SESSION_NOTICE;
  return null;
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
  listLoading,
  listError,
  errorMessage,
  plugins,
  isReadOnly,
  caps,
  pendingIds,
  runMutation,
  onRequestRemove,
}: {
  readonly listLoading: boolean;
  readonly listError: boolean;
  readonly errorMessage: string | null;
  readonly plugins: readonly ProviderPlugin[];
  readonly isReadOnly: boolean;
  readonly caps: ProviderPluginsCapabilities;
  readonly pendingIds: ReadonlySet<string>;
  readonly runMutation: (
    mutation: ProvidersPluginsMutateAction,
    trackId: string | null,
  ) => void;
  readonly onRequestRemove: (plugin: ProviderPlugin) => void;
}): ReactNode {
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
  if (plugins.length === 0) {
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
  return (
    <ul className="flex flex-col gap-2">
      {plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          caps={caps}
          isReadOnly={isReadOnly || plugin.readOnly}
          pending={pendingIds.has(plugin.id)}
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
  plugin,
  caps,
  isReadOnly,
  pending,
  onToggle,
  onRemove,
}: {
  readonly plugin: ProviderPlugin;
  readonly caps: ProviderPluginsCapabilities;
  readonly isReadOnly: boolean;
  readonly pending: boolean;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const canRemove = caps.actionScopes.remove.length > 0;
  const canEnableDisable = caps.actionScopes.setEnabled.length > 0;
  const sourceBadge = plugin.source ?? null;
  return (
    <li
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2",
        pending && "opacity-70",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {plugin.name}
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
