import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import type {
  ModelProviderAuthResult,
  ModelProviderEntry,
  ModelProvidersListResult,
  ProviderModelProvidersCapabilities,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { ModelProviderMark } from "@/components/home/pickers/model-provider-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useProvidersModelProvidersList } from "@/hooks/providers/use-providers-model-providers-list-query";
import { useProvidersModelProviderAuth } from "@/hooks/providers/use-providers-model-provider-auth-mutation";
import { useHostBinding } from "@/lib/host/runtime";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
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
  type StoredCustomKeys,
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

const NO_STORED_KEYS: StoredCustomKeys = { models: [], headers: [] };

/** The provider an open EDIT form is for - null for a fresh declaration. */
function openCustomFormId(
  state: { readonly initial: CustomProviderValues | null } | null,
): string | null {
  if (state === null || state.initial === null) return null;
  return state.initial.modelProviderId;
}

/** The open form's locks were captured when it opened, and the host commits a config block before it reports
 * the credential step - so a failed write can still have stored rows the form believes are unsaved. */
function storedCustomKeysFor(
  entries: readonly ModelProviderEntry[],
  modelProviderId: string | null,
): StoredCustomKeys {
  if (modelProviderId === null) return NO_STORED_KEYS;
  const entry = entries.find((row) => row.id === modelProviderId);
  if (entry === undefined || entry.custom === null) return NO_STORED_KEYS;
  return {
    models: entry.custom.models.map((model) => model.id),
    headers: entry.custom.headers.map((header) => header.key),
  };
}

type RowError = {
  readonly modelProviderId: string;
  readonly message: string;
};

/** Adopts a stored OAuth attempt as the open connect target, during render and guarded by the entry map's
 * identity. */
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

/** The inline row message a disconnect can leave behind, or null when it succeeded. Typed arms only - a
 * transport failure is the mutation's own `onError` toast. */
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

/** Inline in the dialog rather than a toast, and unlike the row paths this one keeps the form open: everything
 * the user typed is still on screen, and a rejected base URL is fixed where it was typed. */
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

/** For a config-declared custom provider it is upstream's disable: the block the user wrote stays in the config
 * file and the provider stops being offered. */
function disconnectDescription(
  entry: ModelProviderEntry,
  providerLabel: string,
): string {
  if (entry.configDeclaredCustom) {
    return `Disconnect ${entry.name}? Its declaration stays in ${providerLabel}'s config file, so you can turn it back on later.`;
  }
  return `Remove the stored ${entry.name} credential from ${providerLabel}? If an environment variable or config file also provides it, ${entry.name} keeps working from that source.`;
}

/** A single id migrated the spinner from the first row to the second instead of showing both. */
function busyRowIds(args: {
  readonly disconnectingId: string | null;
  readonly configWritingId: string | null;
}): readonly string[] {
  const ids: string[] = [];
  if (args.disconnectingId !== null) ids.push(args.disconnectingId);
  if (args.configWritingId !== null && !ids.includes(args.configWritingId)) {
    ids.push(args.configWritingId);
  }
  return ids;
}

/** Either verb does it - the dialog decides which arms it can actually present, and shows the unavailable ones
 * with a reason rather than hiding them. */
function isConnectable(
  capabilities: ProviderModelProvidersCapabilities,
): boolean {
  return (
    capabilities.actions.includes("connect") ||
    capabilities.actions.includes("oauth")
  );
}

/** Reporting it as taken would block the one flow that repairs such a row. */
function disabledCustomIds(
  entries: readonly ModelProviderEntry[],
): readonly string[] {
  return entries
    .filter((entry) => entry.configDeclaredCustom && !entry.connected)
    .map((entry) => entry.id);
}

/** Those are auth-store removals that touch no file, and serializing them against the form would be
 * over-serializing two actions that never contend. */
function disconnectWritesConfig(entry: ModelProviderEntry): boolean {
  return entry.source === "config";
}

function entriesOf(
  result: ModelProvidersListResult | undefined,
): readonly ModelProviderEntry[] {
  if (result === undefined || !result.ok) return EMPTY_ENTRIES;
  return sortModelProviderEntries(result.providers);
}

/** Not the auto-adopt candidate: with two live attempts on one host that is the newer one. */
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

/** That one is `auth.remove` through the server - it does not touch the config file, so locking it would
 * serialize actions that never contend. */
type ConfigWriteOwner = {
  readonly activeModelProviderId: string | null;
  /** Takes ownership, or answers null when someone else already holds it. */
  readonly claim: (modelProviderId: string) => number | null;
  readonly isCurrent: (token: number) => boolean;
  readonly release: (token: number) => void;
};

function useConfigWriteOwner(): ConfigWriteOwner {
  const [active, setActive] = useState<{
    readonly token: number;
    readonly modelProviderId: string;
  } | null>(null);
  const activeRef = useRef<{
    readonly token: number;
    readonly modelProviderId: string;
  } | null>(null);
  const tokenRef = useRef(0);

  const claim = useCallback((modelProviderId: string) => {
    if (activeRef.current !== null) return null;
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    activeRef.current = { token, modelProviderId };
    setActive({ token, modelProviderId });
    return token;
  }, []);
  const isCurrent = useCallback((token: number) => {
    return activeRef.current?.token === token;
  }, []);
  const release = useCallback((token: number) => {
    if (activeRef.current?.token !== token) return;
    activeRef.current = null;
    setActive(null);
  }, []);

  return {
    activeModelProviderId: active?.modelProviderId ?? null,
    claim,
    isCurrent,
    release,
  };
}

/** Its own hook rather than four more `useState`s in the tab. */
function useCustomProviderForm(
  providerId: ProviderId,
  configWrite: ConfigWriteOwner,
): {
  readonly state: { readonly initial: CustomProviderValues | null } | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly open: (initial: CustomProviderValues | null) => void;
  readonly close: () => void;
  readonly submit: (values: CustomProviderValues) => void;
  readonly reenable: (values: CustomProviderValues) => void;
} {
  const [state, setState] = useState<{
    readonly initial: CustomProviderValues | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Its own mutation instance rather than the tab's.
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
      // One config write at a time.
      const token = configWrite.claim(values.modelProviderId);
      if (token === null) return;
      setError(null);
      auth.mutate(
        {
          providerId,
          action: {
            // `updateCustom` is only reachable for a row the host flagged `configDeclaredCustom`, which is the same set of
            // rows it will accept an update for.
            action: declaring ? "createCustom" : "updateCustom",
            modelProviderId: values.modelProviderId,
            name: values.name,
            baseUrl: values.baseUrl,
            models: values.models.map((model) => ({ ...model })),
            headers: values.headers.map((header) => ({ ...header })),
            // Null means "leave whatever is stored alone" - the read side never carries a key back, so an edit that types
            // nothing must not be read as clearing the credential.
            key: values.key,
            // Same word, and the empty array is not the same as it: `[]` is the wire's clear signal, so an untouched form
            // must send null rather than an empty list it happens to be holding.
            env: values.env === null ? null : [...values.env],
          },
        },
        {
          onSuccess: (data) => {
            // Guarded by identity, not by "is something pending": a completion that is no longer the current write must
            // not touch the surface.
            if (!configWrite.isCurrent(token)) return;
            const failure = customSubmitError(data.result);
            setError(failure);
            // A failure lands the user in the form for these values, whether or not they came from one.
            setState(failure === null ? null : { initial: values });
          },
          onSettled: () => {
            configWrite.release(token);
          },
        },
      );
    },
    [auth, configWrite, providerId],
  );

  const submit = useCallback(
    (values: CustomProviderValues) => {
      send(values, state === null || state.initial === null);
    },
    [send, state],
  );
  const reenable = useCallback(
    (values: CustomProviderValues) => {
      // Re-enable is not an env instruction, so it sends none. Null says the only true thing here: turn this back
      // on, touch nothing else.
      send({ ...values, env: null }, false);
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
  /** Passed in rather than re-derived: the tab holds no provider list, and the row it would need is the one its
   * caller is already rendering. */
  readonly packPreparing: ProviderPackPreparing | null;
}): ReactNode {
  const { providerId, providerLabel, capabilities, packPreparing } = props;
  // Subscribed for the re-render; the id itself comes off the bound client, because Settings can target a
  // non-active host.
  const activeHostId = useAddressableHostId();
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
  const configWrite = useConfigWriteOwner();
  const customForm = useCustomProviderForm(providerId, configWrite);
  const pendingAuthEntries = useModelProviderPendingAuthStore((s) => s.entries);

  const result: ModelProvidersListResult | undefined = listQuery.data?.result;
  const entries = useMemo(() => entriesOf(result), [result]);
  // Filter first, then search: the fuzzy matcher ranks what it is given, so narrowing the candidate set before
  // it runs keeps a query's results inside the bucket the user picked instead of quietly re-widening it.
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

  // Which row should re-open BY itself after a navigation. Newest wins; it decides nothing about the row the
  // user opens by hand.
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
    // A plain disconnect is `auth.remove` through the server and touches no file, so it runs unlocked; locking it
    // would serialize two actions that never contend.
    const writesConfig = disconnectWritesConfig(target);
    const token = writesConfig ? configWrite.claim(target.id) : null;
    if (writesConfig && token === null) return;
    setRowError(null);
    auth.mutate(
      {
        providerId,
        action: { action: "disconnect", modelProviderId: target.id },
      },
      {
        onSuccess: (data) => {
          if (token !== null && !configWrite.isCurrent(token)) return;
          setRowError(disconnectRowError(target.id, data.result));
        },
        onSettled: () => {
          if (token !== null) configWrite.release(token);
          setDisconnectTarget(null);
        },
      },
    );
  }, [auth, configWrite, disconnectTarget, providerId]);

  const canDisconnect = capabilities.actions.includes("disconnect");
  const connectable = isConnectable(capabilities);
  const canCreateCustom = capabilities.actions.includes("createCustom");
  // Memoized on the catalog, so the open form re-locks when a refetch actually
  // changes what is declared and never on an unrelated render.
  const openFormId = openCustomFormId(customForm.state);
  const storedKeysForOpenForm = useMemo(
    () => storedCustomKeysFor(entries, openFormId),
    [entries, openFormId],
  );
  // Hoisted out of JSX: `eslint --fix` (react/jsx-no-leaked-render) rewrites a logical `&&` inside a JSX
  // attribute into `cond ?
  const disconnectPending = auth.isPending && disconnectTarget !== null;
  // Hoisted out of JSX for the same reason `disconnectPending` is: `eslint --fix` rewrites a logical `&&` in an
  // attribute into `cond ?
  const listRefreshing = listQuery.isFetching && !listQuery.isPending;
  const busyModelProviderIds = busyRowIds({
    disconnectingId: disconnectPending ? disconnectTarget.id : null,
    configWritingId: configWrite.activeModelProviderId,
  });

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
        // It never did, exactly: the fill stopped at the padded container's edges and left a visible band beside the
        // input.
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
        // A refetch after a mutation is not instant and cannot be made so.
        refreshing={listRefreshing}
        // A transport error message is host-authored text on a credential surface, and the one place it was passed
        // through raw is the one place nobody thought of it as such.
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
        canCreateCustom={canCreateCustom}
        onAddCustom={() => {
          customForm.open(null);
        }}
        canUpdateCustom={capabilities.actions.includes("updateCustom")}
        onEditCustom={customForm.open}
        onReenableCustom={customForm.reenable}
        connectable={connectable}
        rowError={rowError}
        // One id would have migrated the spinner from the first row to the second instead of showing both.
        busyModelProviderIds={busyModelProviderIds}
        configWriteInFlight={configWrite.activeModelProviderId !== null}
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
          disabledIds={disabledCustomIds(entries)}
          initial={customForm.state.initial}
          stored={storedKeysForOpenForm}
          isPending={customForm.isPending}
          submitError={customForm.error}
          onSubmit={customForm.submit}
        />
      ) : null}

      <ConfirmDestructiveDialog
        blockedReason={null}
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
  /** A refetch is in flight over data already on screen. */
  readonly refreshing: boolean;
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
  readonly canCreateCustom: boolean;
  readonly onAddCustom: () => void;
  readonly canUpdateCustom: boolean;
  readonly configWriteInFlight: boolean;
  readonly onEditCustom: (values: CustomProviderValues) => void;
  readonly onReenableCustom: (values: CustomProviderValues) => void;
  readonly rowError: {
    readonly modelProviderId: string;
    readonly message: string;
  } | null;
  readonly busyModelProviderIds: readonly string[];
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
    // A pack that is still downloading is a wait, not a failure, and the host cannot tell us so.
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
        // `capability_unavailable` means the surface is not offered on this host at all - a retry cannot change that,
        // and offering one would be a button that is guaranteed to do nothing.
        actionLabel={result.code === "server_unavailable" ? "Retry" : null}
        onAction={result.code === "server_unavailable" ? props.onRetry : null}
      />
    );
  }
  if (props.unfilteredCount === 0) {
    // Declaring a provider is precisely what an empty list is for.
    return (
      <ModelProviderListShell
        canCreateCustom={props.canCreateCustom}
        configWriteInFlight={props.configWriteInFlight}
        onAddCustom={props.onAddCustom}
        refreshing={props.refreshing}
      >
        <li className="w-full py-2">
          <EmptyState
            title="No model providers"
            description={`${props.providerLabel} reported no upstream providers on this host.`}
            actionLabel={null}
            onAction={null}
          />
        </li>
      </ModelProviderListShell>
    );
  }
  if (props.entries.length === 0 && props.searchActive) {
    // Inside the shell, not instead of it: "Add custom provider" is exactly the affordance a fruitless search
    // wants, so the one branch that would have hidden it is the one where it matters most.
    return (
      <ModelProviderListShell
        canCreateCustom={props.canCreateCustom}
        configWriteInFlight={props.configWriteInFlight}
        onAddCustom={props.onAddCustom}
        refreshing={props.refreshing}
      >
        <li className="w-full py-2">
          <ProviderListSearchEmptyState
            query={props.searchQuery}
            resourceLabel="providers"
          />
        </li>
      </ModelProviderListShell>
    );
  }
  // A filter with no query needs its own line: the search empty state quotes a
  // query, and quoting an empty one would read as a bug rather than a filter.
  if (props.entries.length === 0 && props.filterEmptyDescription !== null) {
    return (
      <ModelProviderListShell
        canCreateCustom={props.canCreateCustom}
        configWriteInFlight={props.configWriteInFlight}
        onAddCustom={props.onAddCustom}
        refreshing={props.refreshing}
      >
        <li className="w-full py-2">
          <EmptyState
            title="No matching providers"
            description={props.filterEmptyDescription}
            actionLabel={null}
            onAction={null}
          />
        </li>
      </ModelProviderListShell>
    );
  }
  return (
    <ModelProviderListShell
      canCreateCustom={props.canCreateCustom}
      configWriteInFlight={props.configWriteInFlight}
      onAddCustom={props.onAddCustom}
      refreshing={props.refreshing}
    >
      {props.entries.map((entry) => (
        <ModelProviderRow
          key={entry.id}
          entry={entry}
          providerLabel={props.providerLabel}
          canDisconnect={props.canDisconnect}
          connectable={props.connectable}
          canUpdateCustom={props.canUpdateCustom}
          configWriteInFlight={props.configWriteInFlight}
          busy={props.busyModelProviderIds.includes(entry.id)}
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
    </ModelProviderListShell>
  );
}

/** Invariant: the Add affordance must survive every list state where creation is possible. This hazard has now
 * arrived three different ways. */
function ModelProviderListShell(props: {
  readonly canCreateCustom: boolean;
  readonly configWriteInFlight: boolean;
  readonly onAddCustom: () => void;
  readonly refreshing: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <>
      <RefreshingNotice refreshing={props.refreshing} />
      <ul
        className={cn(
          "flex w-full flex-col divide-y divide-border/40",
          // A skeleton would throw away rows that are still mostly right; this says "being re-checked" while keeping
          // them readable, and the banner above names what is happening.
          props.refreshing && "opacity-60",
        )}
        aria-busy={props.refreshing}
        data-testid="model-provider-list"
      >
        {props.canCreateCustom ? (
          // It stays rendered whatever the search says, because it is an affordance rather than a result.
          <li className="w-full">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-full justify-start gap-2 px-0 text-muted-foreground hover:text-foreground"
              // Closed while a config write is in flight: declaring through this would open a form whose Save the guard
              // drops, and an older completion would land on the newer dialog's state.
              disabled={props.configWriteInFlight}
              onClick={props.onAddCustom}
            >
              <Plus className="size-3.5" />
              Add custom provider
            </Button>
          </li>
        ) : null}
        {props.children}
      </ul>
    </>
  );
}

/** It is offered only when those values would survive the write side. */
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

/** Says a refetch is happening, because the alternative is a row that looks settled and is not. */
function RefreshingNotice(props: { readonly refreshing: boolean }): ReactNode {
  if (!props.refreshing) return null;
  return (
    <div
      className="flex items-center gap-2 py-1 text-ui-xs text-muted-foreground"
      role="status"
    >
      <MutedAgentSpinner />
      Refreshing providers
    </div>
  );
}

function ModelProviderRow(props: {
  readonly entry: ModelProviderEntry;
  readonly providerLabel: string;
  readonly canDisconnect: boolean;
  readonly connectable: boolean;
  readonly canUpdateCustom: boolean;
  readonly configWriteInFlight: boolean;
  readonly busy: boolean;
  readonly rowError: string | null;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onEditCustom: (values: CustomProviderValues) => void;
  readonly onReenableCustom: (values: CustomProviderValues) => void;
}): ReactNode {
  const { entry } = props;
  const custom = customRowActions(entry, props.canUpdateCustom);
  // They all rewrite one file, and a completion that lands after the user started something else would apply its
  // result to state that has moved on.
  const configBusy = props.busy || props.configWriteInFlight;
  // The affordance is gated on `canDisconnect` alone.
  const showDisconnect = props.canDisconnect && entry.canDisconnect;
  // A declared custom row that is off re-enables from its own values; asking it to Connect would demand a key
  // for a provider whose credential is not the thing that was turned off.
  const showConnect =
    props.connectable && !showDisconnect && custom?.reenable !== true;
  return (
    <li className="w-full">
      <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* A user-declared provider has no brand, so it takes the generic
           * mark the same way an id we have no logo for does. */}
          <ModelProviderMark
            id={entry.id}
            configDeclaredCustom={entry.configDeclaredCustom}
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
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
              disabled={configBusy}
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
              disabled={configBusy}
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
              // Row-specific, like its three siblings: "Connect" alone repeats ~180 times in the accessibility tree with
              // nothing saying which provider each one belongs to.
              aria-label={`Connect ${entry.name}`}
            >
              Connect
            </Button>
          ) : null}
          {showDisconnect ? (
            // Text, not an icon, and upstream's word for it. Destructive intent still arrives on hover rather than as
            // permanent red, matching the rest of Settings.
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(
                "text-muted-foreground",
                "hover:bg-destructive/10 hover:text-destructive",
              )}
              // A config-sourced row's Disconnect is a config write (it appends to `disabled_providers`), so it closes with
              // the rest while one is in flight - declared custom or not, since both reach the file the same way.
              disabled={disconnectWritesConfig(entry) ? configBusy : props.busy}
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
