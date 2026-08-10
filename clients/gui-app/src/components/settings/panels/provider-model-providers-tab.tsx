import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
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
  sortModelProviderEntries,
  sourceBadgeHint,
  sourceBadgeLabel,
} from "./model-provider-connect-model";
import {
  canReenableCustomProvider,
  customProviderValuesOf,
  type CustomProviderValues,
} from "./model-provider-custom-draft";
import { ProviderCustomModelProviderDialog } from "./provider-custom-model-provider-dialog";
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

/**
 * What a custom-provider write left behind, or null when it landed.
 *
 * Inline in the dialog rather than a toast, and unlike the row paths this one
 * keeps the form open: everything the user typed is still on screen, and a
 * rejected base URL is fixed where it was typed.
 */
function customSubmitError(result: ModelProviderAuthResult): string | null {
  if (result.kind === "error") {
    return redactLogText(
      modelProviderAuthErrorMessage(result.code, result.detail),
    );
  }
  if (result.kind === "unsupported") {
    return redactLogText(
      result.reason ?? "Custom providers aren't available on this host.",
    );
  }
  return null;
}

/**
 * What Disconnect actually does to THIS row, which is two different things.
 *
 * For a config-declared custom provider it is upstream's disable: the block the
 * user wrote stays in the config file and the provider stops being offered. For
 * everything else it removes the stored credential - and that is all it can
 * promise, because an environment variable or config file underneath can take
 * over the moment the stored one is gone.
 */
function disconnectDescription(
  entry: ModelProviderEntry,
  providerLabel: string,
): string {
  if (entry.configDeclaredCustom) {
    return `Disconnect ${entry.name}? Its declaration stays in ${providerLabel}'s config file, so you can turn it back on later.`;
  }
  return `Remove the stored ${entry.name} credential from ${providerLabel}? If an environment variable or config file also provides it, ${entry.name} keeps working from that source.`;
}

/** The catalog a list result carries, sorted, or nothing at all. */
function entriesOf(
  result: ModelProvidersListResult | undefined,
): readonly ModelProviderEntry[] {
  if (result === undefined || !result.ok) return EMPTY_ENTRIES;
  return sortModelProviderEntries(result.providers);
}

/**
 * The attempt belonging to the row the user OPENED, by its full key.
 *
 * Not the auto-adopt candidate: with two live attempts on one host that is the
 * newer one, and reading it here made the older row's live attempt
 * restart-only even though its record was in the store and the host was still
 * holding its server lease.
 */
function attemptForTarget(args: {
  readonly entries: Readonly<Record<string, ModelProviderPendingAuthEntry>>;
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly target: ModelProviderEntry | null;
}): ModelProviderPendingAuthEntry | null {
  const { hostId, target } = args;
  if (target === null || hostId === null) return null;
  return getModelProviderPendingAuth(args.entries, {
    hostId,
    providerId: args.providerId,
    modelProviderId: target.id,
  });
}

/**
 * The custom-provider form's own state and submit path.
 *
 * Its own hook rather than four more `useState`s in the tab: the tab already
 * carries the list, the search, the filter, the connect target and the
 * disconnect target, and the form shares nothing with any of them except the
 * one mutation it borrows.
 */
function useCustomProviderForm(providerId: ProviderId): {
  /** The open form, or null. `initial` is what separates edit from declare. */
  readonly state: { readonly initial: CustomProviderValues | null } | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly open: (initial: CustomProviderValues | null) => void;
  readonly close: () => void;
  readonly submit: (values: CustomProviderValues) => void;
  /** Re-enable a declared row from its own values, with no form in between. */
  readonly reenable: (values: CustomProviderValues) => void;
} {
  const [state, setState] = useState<{
    readonly initial: CustomProviderValues | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Its OWN mutation instance rather than the tab's. They share a key and an
  // invalidation, and nothing else: a disconnect in flight has no business
  // spinning this form's submit button, or the other way round.
  const auth = useProvidersModelProviderAuth();

  const open = useCallback((initial: CustomProviderValues | null) => {
    setError(null);
    setState({ initial });
  }, []);
  const close = useCallback(() => {
    setState(null);
  }, []);

  const send = useCallback(
    (values: CustomProviderValues, declaring: boolean) => {
      setError(null);
      auth.mutate(
        {
          providerId,
          action: {
            // One shape, two verbs - the wire's own split. `updateCustom` is
            // only reachable for a row the host flagged `configDeclaredCustom`,
            // which is the same set of rows it will accept an update for.
            action: declaring ? "createCustom" : "updateCustom",
            ...values,
            modelIds: [...values.modelIds],
          },
        },
        {
          onSuccess: (data) => {
            const failure = customSubmitError(data.result);
            setError(failure);
            // A failure lands the user in the form for THESE values, whether or
            // not they came from one. A bare re-enable that the host refused
            // otherwise reports itself on a row with no way to act on it, and
            // the form is the surface that can.
            setState(failure === null ? null : { initial: values });
          },
        },
      );
    },
    [auth, providerId],
  );

  const submit = useCallback(
    (values: CustomProviderValues) => {
      send(values, state === null || state.initial === null);
    },
    [send, state],
  );
  const reenable = useCallback(
    (values: CustomProviderValues) => {
      send(values, false);
    },
    [send],
  );

  return {
    state,
    error,
    isPending: auth.isPending,
    open,
    close,
    submit,
    reenable,
  };
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
  const customForm = useCustomProviderForm(providerId);
  const pendingAuthEntries = useModelProviderPendingAuthStore((s) => s.entries);

  const result: ModelProvidersListResult | undefined = listQuery.data?.result;
  const entries = useMemo(() => entriesOf(result), [result]);
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

  const resumedForTarget = attemptForTarget({
    entries: pendingAuthEntries,
    hostId,
    providerId,
    target: connectTarget,
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
  const canCreateCustom = capabilities.actions.includes("createCustom");
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

      {canCreateCustom ? (
        // ABOVE the search box, not inside the results. It is not a provider
        // the catalog can match, so a search that filters it away would hide
        // the one row whose whole purpose is "what you want isn't in this
        // list" - which is exactly when the user is searching.
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2 px-0 text-muted-foreground hover:text-foreground"
          onClick={() => {
            customForm.open(null);
          }}
        >
          <Plus className="size-3.5" />
          Add custom provider
        </Button>
      ) : null}

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
        // Redacted like every other host string this tab renders. A transport
        // error message is host-authored text on a credential surface, and the
        // one place it was passed through raw is the one place nobody thought
        // of it as such.
        listError={
          listQuery.isError ? redactLogText(listQuery.error.message) : null
        }
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
        canUpdateCustom={capabilities.actions.includes("updateCustom")}
        onEditCustom={customForm.open}
        onReenableCustom={customForm.reenable}
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

      {customForm.state !== null ? (
        <ProviderCustomModelProviderDialog
          open
          onOpenChange={(open) => {
            if (!open) customForm.close();
          }}
          providerLabel={providerLabel}
          takenIds={entries.map((entry) => entry.id)}
          initial={customForm.state.initial}
          isPending={customForm.isPending}
          submitError={customForm.error}
          onSubmit={customForm.submit}
        />
      ) : null}

      <ConfirmDestructiveDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title="Disconnect provider"
        description={
          disconnectTarget === null
            ? ""
            : disconnectDescription(disconnectTarget, providerLabel)
        }
        cascadeSummary={null}
        actionLabel="Disconnect"
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
  readonly canUpdateCustom: boolean;
  readonly onEditCustom: (values: CustomProviderValues) => void;
  readonly onReenableCustom: (values: CustomProviderValues) => void;
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
      // One list, hairline-separated - not a card per provider. At ~180 rows a
      // border around each one turns the surface into a wall of boxes with the
      // provider names as the smallest thing in it; the separators carry the
      // same grouping for a fraction of the ink.
      className="flex max-h-[60vh] w-full flex-col divide-y divide-border/40 overflow-y-auto"
      data-testid="model-provider-list"
    >
      {props.entries.map((entry) => (
        <ModelProviderRow
          key={entry.id}
          entry={entry}
          providerLabel={props.providerLabel}
          canDisconnect={props.canDisconnect}
          connectable={props.connectable}
          canUpdateCustom={props.canUpdateCustom}
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
          onEditCustom={props.onEditCustom}
          onReenableCustom={props.onReenableCustom}
          onDisconnect={() => {
            props.onDisconnect(entry);
          }}
        />
      ))}
    </ul>
  );
}

/**
 * The actions a declared custom row gets on top of the ordinary ones, or null
 * for every other row.
 *
 * `reenable` is `updateCustom` with the row's OWN values - the wire has no
 * enable verb, deliberately, because a second way to say "on" could disagree
 * with disconnect about what "off" means. It is offered only when those values
 * would survive the write side: `opencode.json` is hand-editable, so a
 * declaration can arrive malformed, and a one-click re-enable there would send
 * the user's broken values back and report a failure they never had a chance to
 * fix. That row gets Edit alone, opened on exactly what is wrong.
 */
function customRowActions(
  entry: ModelProviderEntry,
  canUpdateCustom: boolean,
): {
  readonly values: CustomProviderValues;
  readonly reenable: boolean;
} | null {
  if (!canUpdateCustom) return null;
  const values = customProviderValuesOf(entry);
  if (values === null) return null;
  return {
    values,
    reenable: !entry.connected && canReenableCustomProvider(values),
  };
}

function ModelProviderRow(props: {
  readonly entry: ModelProviderEntry;
  readonly providerLabel: string;
  readonly canDisconnect: boolean;
  readonly connectable: boolean;
  readonly canUpdateCustom: boolean;
  readonly busy: boolean;
  readonly rowError: string | null;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEditCustom: (values: CustomProviderValues) => void;
  readonly onReenableCustom: (values: CustomProviderValues) => void;
}): ReactNode {
  const { entry } = props;
  const custom = customRowActions(entry, props.canUpdateCustom);
  // The affordance is gated on `canDisconnect` ALONE. `hasStoredCredential`
  // answers a different question ("does Traycer hold a credential for this?")
  // and a later host may answer the two differently - reading either one for
  // the other is how a button appears that the host will refuse.
  const showDisconnect = props.canDisconnect && entry.canDisconnect;
  // Upstream's own rule, and the reason this is not `!entry.connected`: a
  // connected row the host will NOT let us disconnect (an env-sourced one) must
  // still offer a way in, or it is a dead end that neither explains itself nor
  // lets the user put a credential in place for when the variable is gone.
  // Everywhere else, connected means Disconnect and nothing beside it - which
  // is what "the same buttons under the same conditions" asks for.
  // A declared custom row that is off re-enables from its own values; asking it
  // to Connect would demand a key for a provider whose credential is not the
  // thing that was turned off.
  const showConnect =
    props.connectable && !showDisconnect && custom?.reenable !== true;
  return (
    <li className="w-full">
      <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {entry.connected ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400"
            />
          ) : null}
          <span className="truncate text-ui-sm text-foreground">
            {entry.name}
          </span>
          <span className="truncate text-ui-xs text-muted-foreground">
            {entry.id}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {entry.source !== null ? (
            <TooltipWrapper
              label={sourceBadgeHint(
                entry.source,
                props.providerLabel,
                entry.configDeclaredCustom,
              )}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <Badge
                variant="outline"
                className="h-4 rounded-sm border-border/60 px-1.5 text-[10px] font-normal text-muted-foreground"
              >
                {sourceBadgeLabel(entry.source, entry.configDeclaredCustom)}
              </Badge>
            </TooltipWrapper>
          ) : null}
          {props.busy ? <MutedAgentSpinner /> : null}
          {custom !== null ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={() => {
                props.onEditCustom(custom.values);
              }}
              aria-label={`Edit ${entry.name}`}
            >
              Edit
            </Button>
          ) : null}
          {custom?.reenable === true ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={() => {
                props.onReenableCustom(custom.values);
              }}
              aria-label={`Re-enable ${entry.name}`}
            >
              Re-enable
            </Button>
          ) : null}
          {showConnect ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={props.busy}
              onClick={props.onConnect}
            >
              Connect
            </Button>
          ) : null}
          {showDisconnect ? (
            // Text, not an icon, and upstream's word for it. The icon-only
            // version was the single thing the user could not read off this
            // list - an unplug glyph in a row of quiet text says neither what
            // it removes nor that it is the destructive one. Destructive INTENT
            // still arrives on hover rather than as permanent red, matching the
            // rest of Settings.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "text-muted-foreground",
                "hover:bg-destructive/10 hover:text-destructive",
              )}
              disabled={props.busy}
              onClick={props.onDisconnect}
              aria-label={`Disconnect ${entry.name}`}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>
      {props.rowError !== null ? (
        <p className="pb-2 text-ui-xs text-destructive">{props.rowError}</p>
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
