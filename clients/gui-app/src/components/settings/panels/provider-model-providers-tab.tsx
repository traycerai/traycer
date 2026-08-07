import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Plus, Unplug } from "lucide-react";
import type {
  ModelProviderAuthResult,
  ModelProviderEntry,
  ModelProvidersListResult,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useProvidersModelProvidersList } from "@/hooks/providers/use-providers-model-providers-list-query";
import { useProvidersModelProviderAuth } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import { useHostBinding } from "@/lib/host/runtime";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  modelProviderAuthErrorMessage,
  modelProviderListErrorMessage,
} from "@/lib/providers/model-provider-error-copy";
import { redactLogText } from "@/lib/logger";
import { cn } from "@/lib/utils";
import type { ProviderPackPreparing } from "@/components/providers/provider-pack-readiness";
import { providerPackPreparingLabel } from "@/components/providers/provider-pack-readiness";
import type { ModelProviderPendingAuthEntry } from "@/stores/settings/model-provider-pending-auth-store";
import {
  findModelProviderPendingAuth,
  getModelProviderPendingAuth,
  useModelProviderPendingAuthStore,
} from "@/stores/settings/model-provider-pending-auth-store";
import {
  readOnlySourceHint,
  readOnlySourceLabel,
  sortModelProviderEntries,
  sourceBadgeHint,
  sourceBadgeLabel,
} from "./model-provider-connect-model";
import {
  filterModelProvidersByMethod,
  MODEL_PROVIDER_METHOD_FILTER,
  modelProviderMethodFilterEmptyDescription,
  type ModelProviderMethodFilter,
} from "./model-provider-filter";
import { ModelProviderListControls } from "./model-provider-list-controls";
import {
  filterModelProviders,
  isProviderListSearchActive,
} from "./provider-list-search-filter";
import { ProviderListSearchEmptyState } from "./provider-list-search";
import { ProviderModelProviderConnectDialog } from "./provider-model-provider-connect-dialog";

const EMPTY_ENTRIES: readonly ModelProviderEntry[] = [];

type RowError = {
  readonly modelProviderId: string;
  readonly message: string;
};

/**
 * Adopts a stored OAuth attempt as the open connect target, during RENDER and
 * guarded by the entry map's identity - the same shape as the MCP tab's
 * `useResumeOauthPolling`, and for the same reason: the store is already
 * reactive, so an effect would only add a commit.
 *
 * The guard is what makes the panel both resumable AND dismissible: re-opening
 * is tied to the store CHANGING, so closing a resumed dialog does not
 * immediately re-open it, while a genuinely new attempt still claims the
 * surface.
 */
function useResumedConnectTarget(args: {
  readonly entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>;
  readonly resumed: ModelProviderPendingAuthEntry | null;
  readonly connectTargetId: string | null;
  readonly onAdopt: (modelProviderId: string) => void;
}): void {
  const [seen, setSeen] = useState<object | null>(null);
  if (seen === args.entries) return;
  setSeen(args.entries);
  if (args.resumed === null || args.connectTargetId !== null) return;
  args.onAdopt(args.resumed.key.modelProviderId);
}

/**
 * The inline row message a disconnect can leave behind, or null when it
 * succeeded. Typed arms only - a transport failure is the mutation's own
 * `onError` toast.
 */
function disconnectRowError(
  modelProviderId: string,
  result: ModelProviderAuthResult,
): RowError | null {
  if (result.kind === "error") {
    return {
      modelProviderId,
      message: redactLogText(
        modelProviderAuthErrorMessage(result.code, result.detail),
      ),
    };
  }
  if (result.kind === "unsupported") {
    return {
      modelProviderId,
      message: redactLogText(
        result.reason ??
          "Removing this credential isn't available on this host.",
      ),
    };
  }
  return null;
}

export function ProviderModelProvidersTab(props: {
  readonly providerId: ProviderId;
  readonly providerLabel: string;
  readonly capabilities: ProviderModelProvidersCapabilities;
  /**
   * This provider's managed-pack state, or null when there is nothing to
   * report. Passed in rather than re-derived: the tab holds no provider list,
   * and the row it would need is the one its caller is already rendering.
   */
  readonly packPreparing: ProviderPackPreparing | null;
}): ReactNode {
  const { providerId, providerLabel, capabilities, packPreparing } = props;
  // Subscribed for the re-render; the id itself comes off the BOUND client,
  // because Settings can target a non-active host - the same rule
  // `useProviderNativeScope` follows, and for the same reason: an attempt filed
  // under the wrong host id can never be resumed against the list it started
  // from.
  const activeHostId = useReactiveActiveHostId();
  const binding = useHostBinding();
  const hostId = binding?.hostClient.getActiveHostId() ?? activeHostId;

  const [searchQuery, setSearchQuery] = useState("");
  const [methodFilter, setMethodFilter] = useState<ModelProviderMethodFilter>(
    MODEL_PROVIDER_METHOD_FILTER.All,
  );
  const [connectTargetId, setConnectTargetId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] =
    useState<ModelProviderEntry | null>(null);
  const [rowError, setRowError] = useState<RowError | null>(null);

  const listQuery = useProvidersModelProvidersList({
    providerId,
    enabled: true,
  });
  const auth = useProvidersModelProviderAuth();
  const pendingAuthEntries = useModelProviderPendingAuthStore((s) => s.entries);

  const result: ModelProvidersListResult | undefined = listQuery.data?.result;
  const entries = useMemo(
    () =>
      result !== undefined && result.ok
        ? sortModelProviderEntries(result.providers)
        : EMPTY_ENTRIES,
    [result],
  );
  // Filter first, THEN search: the fuzzy matcher ranks what it is given, so
  // narrowing the candidate set before it runs keeps a query's results inside
  // the bucket the user picked instead of quietly re-widening it.
  const filtered = useMemo(
    () =>
      filterModelProviders(
        filterModelProvidersByMethod(entries, methodFilter),
        searchQuery,
      ),
    [entries, methodFilter, searchQuery],
  );
  const searchActive = isProviderListSearchActive(searchQuery);
  const filterActive = methodFilter !== MODEL_PROVIDER_METHOD_FILTER.All;

  // Which row should re-open BY ITSELF after a navigation. Newest wins; it
  // decides nothing about the row the user opens by hand.
  const autoAdoptAttempt = findModelProviderPendingAuth(pendingAuthEntries, {
    providerId,
    hostId,
  });

  useResumedConnectTarget({
    entries: pendingAuthEntries,
    resumed: autoAdoptAttempt,
    connectTargetId,
    onAdopt: setConnectTargetId,
  });

  const connectTarget =
    connectTargetId === null
      ? null
      : (entries.find((entry) => entry.id === connectTargetId) ?? null);

  // The attempt belonging to THIS row, looked up by its full key rather than
  // taken from the auto-adopt candidate. With two live attempts on one host,
  // the candidate is the newer one - so reading it here made the older row's
  // live attempt restart-only, even though its record was sitting in the store
  // and the host was still holding its server lease.
  const resumedForTarget =
    connectTarget === null || hostId === null
      ? null
      : getModelProviderPendingAuth(pendingAuthEntries, {
          hostId,
          providerId,
          modelProviderId: connectTarget.id,
        });

  const handleDisconnect = useCallback(() => {
    const target = disconnectTarget;
    if (target === null) return;
    setRowError(null);
    auth.mutate(
      {
        providerId,
        action: { action: "disconnect", modelProviderId: target.id },
      },
      {
        onSuccess: (data) => {
          setRowError(disconnectRowError(target.id, data.result));
        },
        onSettled: () => {
          setDisconnectTarget(null);
        },
      },
    );
  }, [auth, disconnectTarget, providerId]);

  const canDisconnect = capabilities.actions.includes("disconnect");
  // Hoisted out of JSX: `eslint --fix` (react/jsx-no-leaked-render) rewrites a
  // logical `&&` inside a JSX attribute into `cond ? value : null`, which makes
  // this `boolean | null` and fails the dialog's `isPending: boolean` prop.
  const disconnectPending = auth.isPending && disconnectTarget !== null;

  return (
    <div
      className="flex w-full flex-col gap-3"
      data-testid="provider-model-providers-tab"
    >
      <p className="text-ui-xs text-muted-foreground">
        Credentials for the upstream model providers {providerLabel} can call.
        They are stored by {providerLabel} itself, so its CLI and Traycer see
        the same sign-ins.
      </p>

      {entries.length > 0 ? (
        <ModelProviderListControls
          query={searchQuery}
          onQueryChange={setSearchQuery}
          filter={methodFilter}
          onFilterChange={setMethodFilter}
          resultCount={filtered.length}
        />
      ) : null}

      <ModelProvidersBody
        listPending={listQuery.isPending}
        listError={listQuery.isError ? listQuery.error.message : null}
        result={result}
        packPreparing={packPreparing}
        providerLabel={providerLabel}
        onRetry={() => {
          void listQuery.refetch();
        }}
        entries={filtered}
        unfilteredCount={entries.length}
        searchQuery={searchQuery}
        searchActive={searchActive}
        filterEmptyDescription={
          filterActive
            ? modelProviderMethodFilterEmptyDescription(methodFilter)
            : null
        }
        canDisconnect={canDisconnect}
        connectable={
          capabilities.actions.includes("connect") ||
          capabilities.actions.includes("oauth")
        }
        rowError={rowError}
        busyModelProviderId={disconnectPending ? disconnectTarget.id : null}
        onConnect={(entry) => {
          setRowError(null);
          setConnectTargetId(entry.id);
        }}
        onDisconnect={setDisconnectTarget}
      />

      {connectTarget !== null ? (
        <ProviderModelProviderConnectDialog
          // Keyed by the target so switching providers rebuilds the form state
          // rather than carrying one provider's answers into another's fields.
          key={connectTarget.id}
          open
          onOpenChange={(open) => {
            if (!open) setConnectTargetId(null);
          }}
          providerId={providerId}
          providerLabel={providerLabel}
          entry={connectTarget}
          capabilities={capabilities}
          hostId={hostId}
          resumedAttempt={resumedForTarget}
          onDone={() => {
            setConnectTargetId(null);
          }}
        />
      ) : null}

      <ConfirmDestructiveDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title="Remove credential"
        description={
          disconnectTarget === null
            ? ""
            : `Remove the stored ${disconnectTarget.name} credential from ${providerLabel}? Models from this provider stop working until you connect it again.`
        }
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={disconnectPending}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}

function ModelProvidersBody(props: {
  readonly listPending: boolean;
  readonly listError: string | null;
  readonly result: ModelProvidersListResult | undefined;
  readonly packPreparing: ProviderPackPreparing | null;
  readonly providerLabel: string;
  readonly onRetry: () => void;
  readonly entries: readonly ModelProviderEntry[];
  readonly unfilteredCount: number;
  readonly searchQuery: string;
  readonly searchActive: boolean;
  /** Copy for an active filter that matched nothing, or null while showing all. */
  readonly filterEmptyDescription: string | null;
  readonly canDisconnect: boolean;
  readonly connectable: boolean;
  readonly rowError: {
    readonly modelProviderId: string;
    readonly message: string;
  } | null;
  readonly busyModelProviderId: string | null;
  readonly onConnect: (entry: ModelProviderEntry) => void;
  readonly onDisconnect: (entry: ModelProviderEntry) => void;
}): ReactNode {
  if (props.listPending) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-sm text-muted-foreground">
        <MutedAgentSpinner />
        Loading model providers
      </div>
    );
  }
  if (props.listError !== null) {
    return (
      <EmptyState
        title="Couldn't load model providers"
        description={props.listError}
        actionLabel="Retry"
        onAction={props.onRetry}
      />
    );
  }
  const result = props.result;
  if (result !== undefined && !result.ok) {
    // A pack that is still downloading is a WAIT, not a failure, and the host
    // cannot tell us so: reaching the catalog needs a managed server, and every
    // reason that server would not start arrives as one `server_unavailable`.
    // The provider row we were handed knows the difference, so the two facts
    // are joined here rather than guessed at from the message text.
    if (result.code === "server_unavailable" && props.packPreparing !== null) {
      return (
        <div
          className="flex items-center gap-2 py-6 text-ui-sm text-muted-foreground"
          role="status"
        >
          <MutedAgentSpinner />
          {providerPackPreparingLabel(props.packPreparing, props.providerLabel)}
        </div>
      );
    }
    return (
      <EmptyState
        title={
          result.code === "capability_unavailable"
            ? "Not available here"
            : "Couldn't load model providers"
        }
        description={redactLogText(
          modelProviderListErrorMessage(result.code, result.detail),
        )}
        // `capability_unavailable` means the surface is not offered on this
        // host at all - a retry cannot change that, and offering one would be a
        // button that is guaranteed to do nothing.
        actionLabel={result.code === "server_unavailable" ? "Retry" : null}
        onAction={result.code === "server_unavailable" ? props.onRetry : null}
      />
    );
  }
  if (props.unfilteredCount === 0) {
    return (
      <EmptyState
        title="No model providers"
        description={`${props.providerLabel} reported no upstream providers on this host.`}
        actionLabel={null}
        onAction={null}
      />
    );
  }
  if (props.entries.length === 0 && props.searchActive) {
    return (
      <ProviderListSearchEmptyState
        query={props.searchQuery}
        resourceLabel="providers"
      />
    );
  }
  // A filter with no query needs its own line: the search empty state quotes a
  // query, and quoting an empty one would read as a bug rather than a filter.
  if (props.entries.length === 0 && props.filterEmptyDescription !== null) {
    return (
      <EmptyState
        title="No matching providers"
        description={props.filterEmptyDescription}
        actionLabel={null}
        onAction={null}
      />
    );
  }
  return (
    // The catalog is ~180 rows, so it gets its own bounded scroll region rather
    // than extending the tab's: a page whose scrollbar spans the whole catalog
    // buries every other control on the tab. Capped against the VIEWPORT
    // alone - no px/rem branch - so the cap scales with the window rather than
    // freezing at one text size.
    //
    // Not virtualized. These rows are one line of text plus a button - no
    // images, no per-row queries - so 180 of them cost one cheap render pass;
    // the panel that does virtualize (Worktrees) does it for thousands of rows
    // that each drive their own enrichment fetch. A virtualizer would also make
    // this list untestable under jsdom, which reports every element as
    // zero-height and would leave the viewport empty.
    <ul
      className="flex max-h-[60vh] w-full flex-col gap-2 overflow-y-auto"
      data-testid="model-provider-list"
    >
      {props.entries.map((entry) => (
        <ModelProviderRow
          key={entry.id}
          entry={entry}
          providerLabel={props.providerLabel}
          canDisconnect={props.canDisconnect}
          connectable={props.connectable}
          busy={props.busyModelProviderId === entry.id}
          rowError={
            props.rowError !== null &&
            props.rowError.modelProviderId === entry.id
              ? props.rowError.message
              : null
          }
          onConnect={() => {
            props.onConnect(entry);
          }}
          onDisconnect={() => {
            props.onDisconnect(entry);
          }}
        />
      ))}
    </ul>
  );
}

function ModelProviderRow(props: {
  readonly entry: ModelProviderEntry;
  readonly providerLabel: string;
  readonly canDisconnect: boolean;
  readonly connectable: boolean;
  readonly busy: boolean;
  readonly rowError: string | null;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
}): ReactNode {
  const { entry } = props;
  // The affordance is gated on `canDisconnect` ALONE. `hasStoredCredential`
  // answers a different question ("does Traycer hold a credential for this?")
  // and a later host may answer the two differently - reading either one for
  // the other is how a button appears that the host will refuse.
  const showDisconnect = props.canDisconnect && entry.canDisconnect;
  // A credential Traycer did not write and cannot remove: an env var, an
  // OpenCode config block, or a provider plugin. The row is READ-ONLY, which
  // has to include the write affordance as well as the remove one - a
  // "Replace" here would store a key into the auth store that the env var
  // keeps shadowing, so the click appears to work and changes nothing. Undoing
  // that shadowing is explicitly out of v1 scope (the host cannot even read
  // its own auth store), so the honest surface is no button and a line saying
  // where the credential actually comes from.
  const externallyManaged =
    entry.connected && entry.source !== null && entry.source !== "api";
  const readOnlyLabel =
    entry.source === null ? null : readOnlySourceLabel(entry.source);
  const readOnlyHint =
    entry.source === null
      ? null
      : readOnlySourceHint(entry.source, entry.credentialKey);
  return (
    <li className="rounded-lg border border-border/60">
      <div className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              entry.connected
                ? "bg-emerald-500 dark:bg-emerald-400"
                : "bg-muted-foreground/40",
            )}
          />
          <span className="truncate text-ui-sm font-medium text-foreground">
            {entry.name}
          </span>
          <span className="truncate text-ui-xs text-muted-foreground">
            {entry.id}
          </span>
          {entry.source !== null ? (
            <TooltipWrapper
              label={sourceBadgeHint(entry.source, props.providerLabel)}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Badge
                variant="outline"
                className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal text-muted-foreground"
              >
                {sourceBadgeLabel(entry.source, props.providerLabel)}
              </Badge>
            </TooltipWrapper>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.busy ? <MutedAgentSpinner /> : null}
          {externallyManaged && readOnlyLabel !== null ? (
            <TooltipWrapper
              label={readOnlyHint}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <span
                className="cursor-help text-ui-xs text-muted-foreground underline decoration-dotted underline-offset-2"
                data-testid="model-provider-read-only-label"
              >
                {readOnlyLabel}
              </span>
            </TooltipWrapper>
          ) : null}
          {props.connectable && !externallyManaged ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={props.onConnect}
            >
              <Plus className="size-3.5" />
              {entry.connected ? "Replace" : "Connect"}
            </Button>
          ) : null}
          {showDisconnect ? (
            // Destructive INTENT on hover, matching the icon-level pattern the
            // rest of Settings uses for a delete affordance
            // (`provider-cli-candidates-section`, `env-override-editor`): a
            // quiet control that turns red only under the pointer, rather than
            // a permanently-red button sitting in a list of neutral rows.
            //
            // The tooltip names what is actually removed - the key in the
            // provider's store - because "disconnect" is not guaranteed: an
            // env var or config block underneath can take over the moment the
            // stored key is gone, and the row would come back connected from
            // another source.
            <TooltipWrapper
              label="Remove saved key"
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className={cn(
                  "text-muted-foreground",
                  "hover:bg-destructive/10 hover:text-destructive",
                )}
                disabled={props.busy}
                onClick={props.onDisconnect}
                aria-label={`Remove saved ${entry.name} key`}
              >
                <Unplug className="size-3.5" />
              </Button>
            </TooltipWrapper>
          ) : null}
        </div>
      </div>
      {props.rowError !== null ? (
        <p className="border-t border-border/40 px-3 py-2 text-ui-xs text-destructive">
          {props.rowError}
        </p>
      ) : null}
    </li>
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
