import type { HostRpcRegistry } from "@/lib/host";
import type {
  ProfileSyncList,
  ProfileSyncRule,
  ProfileSyncItem,
} from "@traycer/protocol/host/profile-sync-schemas";
import { PROFILE_SYNC_MAX_ITEMS } from "@traycer/protocol/host/profile-sync-schemas";
import type { Dispatch, SetStateAction } from "react";
import {
  useQueryClient,
  type UseQueryResult,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderCliState } from "@traycer/protocol/host/provider-schemas";
import type { ProfileSyncBatch } from "@traycer/protocol/host/profile-sync-schemas";
import { useId, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  ProfileSyncSelection,
  ProfileSyncPreview,
} from "@traycer/protocol/host/profile-sync-schemas";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  useProfileSyncList,
  useProfileSyncPreview,
  useProfileSyncStart,
  useProfileSyncPending,
} from "@/hooks/providers/use-profile-sync";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  profileSyncListKey,
  writeProfileSyncBatch,
} from "@/hooks/providers/profile-sync-cache";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import {
  PROFILE_COPY_PROVIDERS,
  profileCopyWireProvider,
  profileCopyPreviewRecord,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { presentProfileCopyPreview } from "@/lib/profile-copy/profile-copy-presentation";
import {
  hostOptionStatusWord,
  AVAILABLE_HOST_ROW_SURFACE_STATE,
} from "../../host-scope/host-option-model";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  type ProfileCopyHosts,
} from "../profile-copy/profile-copy-shared";
import { ProfileSyncProviderPicker } from "./profile-sync-provider-picker";
import { ProfileSyncRules } from "./profile-sync-rules";
import { ProfileSyncResults } from "./profile-sync-results";
import {
  SYNC_STATE_LABELS,
  reconcileSyncRetryBatch,
  reconcileSyncListBatch,
  profileSyncItemObservationKey,
  type ProfileSyncRetryReceipt,
} from "./profile-sync-state";

export function ProfileSyncModal(props: {
  readonly sourceHostId: string;
  readonly initialProvider: ProfileCopyWireProvider | null;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const {
    sourceHostId,
    hosts,
    tab,
    setTab,
    selected,
    setSelected,
    destinations,
    setDestinations,
    setBatchId,
    close,
    catalog,
    list,
    rules,
    selection,
    selectionKey,
    settledKey,
    preview,
    currentPreview,
    previewMismatch,
    start,
    startError,
    batch,
    acceptResolved,
    acceptRetried,
    sourceName,
    canStart,
    selectionTooLarge,
    nothingStarted,
    startRefusal,
    pending,
    run,
  } = useProfileSyncModalState(props);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync profiles</DialogTitle>
        <DialogDescription>
          From {sourceName} to your selected devices.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="px-5 pt-3">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (pending) return;
              setTab(value);
              setBatchId(null);
            }}
          >
            <TabsList>
              <TabsTrigger value="now" disabled={pending}>
                Sync now
              </TabsTrigger>
              <TabsTrigger value="automatic" disabled={pending}>
                {automaticTabLabel(rules)}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
          <ProfileSyncLoadStatus
            catalog={catalog}
            list={list}
            sourceName={sourceName}
          />
          {batch !== null ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                className="self-start"
                disabled={pending}
                onClick={() => setBatchId(null)}
              >
                ← Back
              </Button>
              <ProfileSyncResults
                sourceHostId={sourceHostId}
                batch={batch}
                hosts={hosts}
                onResolved={acceptResolved}
                onRetried={acceptRetried}
              />
            </>
          ) : null}
          {batch === null && tab === "automatic" && list.data !== undefined ? (
            <ProfileSyncRules
              hostId={sourceHostId}
              hosts={hosts}
              providers={catalog.data?.providers ?? []}
              rules={rules}
              batches={list.data.batches}
              onViewRun={setBatchId}
            />
          ) : null}
          {batch === null && tab === "now" ? (
            <ProfileSyncSelectionContent
              sourceHostId={sourceHostId}
              hosts={hosts}
              disabled={pending}
              providers={catalog.data?.providers ?? []}
              selected={selected}
              setSelected={setSelected}
              destinations={destinations}
              setDestinations={setDestinations}
              currentPreview={currentPreview}
              preview={preview}
              selectionReady={selection !== null && selectionKey === settledKey}
              checking={preview.isFetching || selectionKey !== settledKey}
              startError={startError}
              previewMismatch={previewMismatch}
              nothingStarted={nothingStarted}
              startRefusal={startRefusal}
              batches={list.data?.batches ?? []}
              onViewRun={setBatchId}
            />
          ) : null}
        </div>
      </div>
      <ProfileSyncFooter
        pending={pending}
        tab={tab}
        batch={batch}
        selected={selected}
        selectionTooLarge={selectionTooLarge}
        destinations={destinations}
        currentPreview={currentPreview}
        close={close}
        canStart={canStart}
        run={run}
        start={start}
      />
    </>
  );
}
function automaticTabLabel(rules: readonly ProfileSyncRule[]): string {
  return rules.length > 0
    ? `Automatic sync (${rules.length})`
    : "Automatic sync";
}

function ProfileSyncFooter({
  pending,
  tab,
  batch,
  selected,
  selectionTooLarge,
  destinations,
  currentPreview,
  close,
  canStart,
  run,
  start,
}: { readonly pending: boolean } & Pick<
  SyncModalModel,
  | "tab"
  | "batch"
  | "selected"
  | "selectionTooLarge"
  | "destinations"
  | "currentPreview"
  | "close"
  | "canStart"
  | "run"
  | "start"
>): ReactNode {
  return (
    <DialogFooter>
      {tab === "now" && batch === null ? (
        <>
          <p className="mr-auto self-center text-ui-xs text-muted-foreground">
            {selectionStatus(
              selected.length,
              destinations.length,
              currentPreview,
              selectionTooLarge,
            )}
          </p>
          <Button variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button disabled={pending || !canStart} onClick={run}>
            {start.isPending ? <MutedAgentSpinner /> : null}Sync now
          </Button>
        </>
      ) : (
        <Button disabled={pending} onClick={close}>
          Done
        </Button>
      )}
    </DialogFooter>
  );
}
function ProfileSyncLoadStatus({
  catalog,
  list,
  sourceName,
}: Pick<SyncModalModel, "catalog" | "list" | "sourceName">): ReactNode {
  return (
    <>
      {" "}
      {catalog.isPending || list.isPending ? (
        <div className="flex gap-2 text-ui-xs text-muted-foreground">
          <MutedAgentSpinner />
          Loading profiles and sync history…
        </div>
      ) : null}
      {catalog.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(catalog.error, sourceName)}
        </p>
      ) : null}
      {list.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(list.error, sourceName)}{" "}
          <Button size="xs" variant="ghost" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
    </>
  );
}
function ProfileSyncPreviewDetails(props: {
  readonly preview: ProfileSyncPreview | null;
  readonly destinationId: string;
  readonly hosts: ProfileCopyHosts;
  readonly checking: boolean;
}): ReactNode {
  if (props.checking)
    return (
      <p className="mt-2 flex items-center gap-2 text-ui-xs text-muted-foreground">
        <MutedAgentSpinner />
        Checking profiles…
      </p>
    );
  if (props.preview === null) return null;
  const items = props.preview.items.filter(
    (i) => i.destinationHostId === props.destinationId,
  );
  const attention = items.filter(
    (i) =>
      !["ready", "synced", "already-present", "queued", "copying"].includes(
        i.state,
      ),
  ).length;
  return (
    <details className="mt-2 text-ui-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {items.length} profiles ·{" "}
        {attention ? `${attention} need review` : "Ready"}
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        {items.map((i) => {
          const preview = i.preview?.destinations.find(
            (d) => d.destinationHostId === i.destinationHostId,
          );
          const presentation =
            preview === undefined || i.outcome !== null
              ? null
              : presentProfileCopyPreview(profileCopyPreviewRecord(preview), {
                  source: props.hosts.nameFor(
                    props.preview?.selection.sourceHostId ?? "",
                  ),
                  destination: props.hosts.nameFor(i.destinationHostId),
                  provider: profileCopyProviderLabel(i.providerId),
                  profile: i.name,
                });
          return (
            <div key={i.operationId}>
              <p>
                {profileCopyProviderLabel(i.providerId)} / {i.name}
              </p>
              <p className="text-muted-foreground">
                {presentation?.body ?? SYNC_STATE_LABELS[i.state]}
              </p>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function selectionStatus(
  providers: number,
  destinations: number,
  preview: ProfileSyncPreview | null,
  selectionTooLarge: boolean,
): string {
  if (selectionTooLarge)
    return `Choose fewer providers or devices: a run supports up to ${PROFILE_SYNC_MAX_ITEMS} profile transfers.`;
  if (providers === 0) return "Choose providers.";
  if (destinations === 0) return "Choose destination devices.";
  if (preview === null) return "Checking selection…";
  return `${preview.items.length} profile transfers selected`;
}

interface SelectionContentProps {
  readonly sourceHostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly disabled: boolean;
  readonly providers: readonly ProviderCliState[];
  readonly selected: ProfileCopyWireProvider[];
  readonly setSelected: (value: ProfileCopyWireProvider[]) => void;
  readonly destinations: string[];
  readonly setDestinations: Dispatch<SetStateAction<string[]>>;
  readonly currentPreview: ProfileSyncPreview | null;
  readonly preview: UseQueryResult<ProfileSyncPreview, HostRpcError>;
  readonly selectionReady: boolean;
  readonly checking: boolean;
  readonly startError: HostRpcError | null;
  readonly previewMismatch: boolean;
  readonly nothingStarted: boolean;
  readonly startRefusal: string | null;
  readonly batches: readonly ProfileSyncBatch[];
  readonly onViewRun: (id: string) => void;
}
function ProfileSyncSelectionContent({
  sourceHostId,
  hosts,
  disabled,
  providers,
  selected,
  setSelected,
  destinations,
  setDestinations,
  currentPreview,
  preview,
  selectionReady,
  checking,
  startError,
  previewMismatch,
  nothingStarted,
  startRefusal,
  batches,
  onViewRun,
}: SelectionContentProps): ReactNode {
  const sourceName = hosts.nameFor(sourceHostId);
  const canCheck = !disabled && selectionReady && !preview.isFetching;
  const recentRuns = batches
    .filter(
      (batch) => batch.sourceHostId === sourceHostId && batch.items.length > 0,
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 5);
  return (
    <>
      {startRefusal !== null ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {startRefusal}
        </p>
      ) : null}
      {previewMismatch ? (
        <p role="alert" className="text-ui-xs text-destructive">
          The device returned a different selection. Check again.
        </p>
      ) : null}
      <ProfileSyncProviderPicker
        providers={providers}
        selected={selected}
        onChange={(value) => {
          if (!disabled) setSelected(value);
        }}
        disabled={disabled}
      />
      <ProfileSyncDestinations
        sourceHostId={sourceHostId}
        hosts={hosts}
        disabled={disabled}
        destinations={destinations}
        setDestinations={setDestinations}
        preview={currentPreview}
        checking={checking}
        canCheck={canCheck}
        check={() => {
          if (!disabled && selectionReady) void preview.refetch();
        }}
      />

      {preview.error ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {profileCopyRequestErrorText(preview.error, sourceName)}
        </p>
      ) : null}
      {currentPreview?.items.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          No eligible profiles were found for this selection.
        </p>
      ) : null}
      {startError ? (
        <p role="alert" className="text-ui-xs text-destructive">
          {startError.code === "E_INVALID_ARGUMENT"
            ? "Profiles changed. Check again before syncing."
            : "The start could not be confirmed. Check recent runs or retry this same selection; it will not create a second transfer."}
        </p>
      ) : null}
      {nothingStarted ? (
        <p role="status" className="text-ui-sm text-muted-foreground">
          Nothing was started. Check the selection and try again.
        </p>
      ) : null}
      {recentRuns.length > 0 ? (
        <section className="flex flex-col gap-2 border-t border-border/50 pt-3">
          <h3 className="text-ui-xs font-medium text-muted-foreground">
            Recent runs
          </h3>
          {recentRuns.map((b) => (
            <Button
              key={b.batchId}
              size="sm"
              variant="ghost"
              className="justify-between"
              disabled={disabled}
              onClick={() => {
                if (!disabled) onViewRun(b.batchId);
              }}
            >
              <span>{new Date(b.createdAt).toLocaleString()}</span>
              <span>{b.items.length} profile transfers</span>
            </Button>
          ))}
        </section>
      ) : null}
    </>
  );
}
function ProfileSyncDestinations({
  sourceHostId,
  hosts,
  disabled,
  destinations,
  setDestinations,
  preview,
  checking,
  canCheck,
  check,
}: {
  readonly sourceHostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly disabled: boolean;
  readonly destinations: string[];
  readonly setDestinations: Dispatch<SetStateAction<string[]>>;
  readonly preview: ProfileSyncPreview | null;
  readonly checking: boolean;
  readonly canCheck: boolean;
  readonly check: () => void;
}): ReactNode {
  const id = useId();
  const candidates = hosts.options.filter((h) => h.hostId !== sourceHostId);
  const selectedDestinations = new Set(destinations);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-ui-sm font-medium">Destination devices</h3>
      {candidates.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          Connect another device to your account to sync profiles to it.
        </p>
      ) : (
        <div className="divide-y divide-border/50 rounded-lg border border-border/60">
          {candidates.map((host) => (
            <div key={host.hostId} className="p-3">
              <label
                htmlFor={`${id}-${host.hostId}`}
                className="flex cursor-pointer items-center gap-3"
              >
                <Checkbox
                  id={`${id}-${host.hostId}`}
                  checked={selectedDestinations.has(host.hostId)}
                  disabled={
                    disabled ||
                    (!selectedDestinations.has(host.hostId) &&
                      destinations.length >= 16)
                  }
                  onCheckedChange={(checked) => {
                    if (disabled) return;
                    setDestinations((current) =>
                      checked === true
                        ? [...current, host.hostId]
                        : current.filter((id) => id !== host.hostId),
                    );
                  }}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-ui-sm font-medium">
                    {host.name}
                  </span>
                  <span className="text-ui-xs text-muted-foreground">
                    {[
                      host.platform,
                      hostOptionStatusWord(
                        host,
                        AVAILABLE_HOST_ROW_SURFACE_STATE,
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
              {destinations.includes(host.hostId) ? (
                <ProfileSyncPreviewDetails
                  preview={preview}
                  destinationId={host.hostId}
                  hosts={hosts}
                  checking={checking}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        disabled={!canCheck}
        onClick={check}
      >
        <RefreshCw data-icon="inline-start" />
        Check again
      </Button>
    </section>
  );
}

interface ScopedStartNotice {
  readonly selectionKey: string;
  readonly revision: string;
}
interface ScopedStartRefusal extends ScopedStartNotice {
  readonly message: string;
}
interface ViewedSyncBatch {
  readonly batch: ProfileSyncBatch;
  readonly listed: ProfileSyncBatch | undefined;
}

function latestViewedSyncBatch(
  current: ViewedSyncBatch,
  listed: ProfileSyncBatch | undefined,
): ViewedSyncBatch {
  // Query owns accepted answers. A changed cached batch is a new observation;
  // omission from bounded history keeps the opened snapshot and observers.
  return listed !== undefined && listed !== current.listed
    ? { batch: reconcileSyncListBatch(listed, current.batch), listed }
    : current;
}

function useProfileSyncViewedBatch(
  sourceHostId: string,
  list: UseQueryResult<ProfileSyncList, HostRpcError>,
): {
  readonly batch: ProfileSyncBatch | null;
  readonly setBatchId: (batchId: string | null) => void;
  readonly acceptStarted: (
    batch: ProfileSyncBatch,
    submitted: ProfileSyncBatch | undefined,
  ) => void;
  readonly acceptResolved: (
    batch: ProfileSyncBatch,
    requested: ProfileSyncItem,
  ) => void;
  readonly acceptRetried: (receipt: ProfileSyncRetryReceipt) => void;
} {
  const queryClient = useQueryClient();
  // A bounded history poll can omit the opened run; its pending action
  // observers and last accepted receipt must remain mounted.
  const [viewedBatch, setViewedBatch] = useState<ViewedSyncBatch | null>(null);
  const readListed = (batchId: string): ProfileSyncBatch | undefined =>
    queryClient
      .getQueryData<ProfileSyncList>(profileSyncListKey(sourceHostId))
      ?.batches.find((batch) => batch.batchId === batchId);
  const accept = (batch: ProfileSyncBatch): void => {
    // Query publication is synchronous and precedes the exits unlocking.
    writeProfileSyncBatch(queryClient, batch);
    setViewedBatch({ batch, listed: readListed(batch.batchId) });
  };
  const observedBatch = list.data?.batches.find(
    (b) => b.batchId === viewedBatch?.batch.batchId,
  );
  const latest =
    viewedBatch !== null
      ? latestViewedSyncBatch(viewedBatch, observedBatch)
      : viewedBatch;
  if (latest !== viewedBatch) setViewedBatch(latest);
  return {
    batch: latest?.batch ?? null,
    setBatchId: (batchId) => {
      const selectedBatch = list.data?.batches.find(
        (b) => b.batchId === batchId,
      );
      setViewedBatch(
        selectedBatch === undefined
          ? null
          : {
              batch: selectedBatch,
              listed: selectedBatch,
            },
      );
    },
    acceptStarted: (batch, submitted) => {
      const listed = readListed(batch.batchId);
      // A changed listed batch proves Start committed; the driver may have
      // advanced it before the answer arrived. A pre-request snapshot does
      // not outrank the answer to a replay of an uncertain Start.
      accept(listed !== submitted ? (listed ?? batch) : batch);
    },
    acceptResolved: (batch, requested) => {
      if (viewedBatch?.batch.batchId !== batch.batchId) return;
      const listed = readListed(batch.batchId);
      const latest = latestViewedSyncBatch(viewedBatch, listed);
      const resolved = batch.items.find(
        (item) => item.operationId === requested.operationId,
      );
      const prior = latest.batch.items.find(
        (item) => item.operationId === requested.operationId,
      );
      // Fence changes to this row, including polled identity/settings and
      // destination draft receipts. Resolve's sibling snapshot is not applied.
      if (
        resolved === undefined ||
        prior === undefined ||
        profileSyncItemObservationKey(prior) !==
          profileSyncItemObservationKey(requested)
      ) {
        setViewedBatch(latest);
        return;
      }
      const accepted = {
        ...latest.batch,
        items: latest.batch.items.map((item) =>
          item.operationId === requested.operationId ? resolved : item,
        ),
      };
      accept(accepted);
    },
    acceptRetried: (receipt) => {
      if (viewedBatch?.batch.batchId !== receipt.batchId) return;
      const listed = readListed(receipt.batchId);
      const latest = latestViewedSyncBatch(viewedBatch, listed);
      const batch = reconcileSyncRetryBatch(latest.batch, receipt);
      if (batch === latest.batch) {
        setViewedBatch(latest);
        return;
      }
      accept(batch);
    },
  };
}

interface SyncModalModel {
  readonly sourceHostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly tab: string;
  readonly setTab: Dispatch<SetStateAction<string>>;
  readonly selected: ProfileCopyWireProvider[];
  readonly setSelected: Dispatch<SetStateAction<ProfileCopyWireProvider[]>>;
  readonly destinations: string[];
  readonly setDestinations: Dispatch<SetStateAction<string[]>>;
  readonly setBatchId: (batchId: string | null) => void;
  readonly close: () => void;
  readonly catalog: UseQueryResult<
    ResponseOfMethod<HostRpcRegistry, "providers.list">,
    HostRpcError
  >;
  readonly list: UseQueryResult<ProfileSyncList, HostRpcError>;
  readonly rules: readonly ProfileSyncRule[];
  readonly selection: ProfileSyncSelection | null;
  readonly selectionKey: string;
  readonly settledKey: string;
  readonly preview: UseQueryResult<ProfileSyncPreview, HostRpcError>;
  readonly currentPreview: ProfileSyncPreview | null;
  readonly previewMismatch: boolean;
  readonly start: UseMutationResult<
    ProfileSyncBatch,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">,
    ProfileSyncBatch | undefined
  >;
  readonly batch: ProfileSyncBatch | null;
  readonly acceptResolved: (
    batch: ProfileSyncBatch,
    requested: ProfileSyncItem,
  ) => void;
  readonly acceptRetried: (receipt: ProfileSyncRetryReceipt) => void;
  readonly startError: HostRpcError | null;
  readonly sourceName: string;
  readonly canStart: boolean;
  readonly selectionTooLarge: boolean;
  readonly nothingStarted: boolean;
  readonly startRefusal: string | null;
  readonly run: () => void;
  readonly pending: boolean;
}
function useProfileSyncModalState(props: {
  readonly sourceHostId: string;
  readonly hosts: ProfileCopyHosts;
  readonly initialProvider: ProfileCopyWireProvider | null;
}): SyncModalModel {
  const { sourceHostId, hosts } = props;
  const pending = useProfileSyncPending(sourceHostId);
  const [tab, setTab] = useState("now");
  const [chosenProviders, setSelected] = useState<ProfileCopyWireProvider[]>(
    props.initialProvider === null
      ? [...PROFILE_COPY_PROVIDERS]
      : [props.initialProvider],
  );
  const { destinations, setDestinations } = useSyncDestinations(
    sourceHostId,
    hosts,
  );
  const [refusedStart, setRefusedStart] = useState<ScopedStartRefusal | null>(
    null,
  );
  const [emptyStart, setEmptyStart] = useState<ScopedStartNotice | null>(null);
  const getSyncStartBatchId = useProfileCopyFlowStore(
    (s) => s.getSyncStartBatchId,
  );
  const forgetSyncStartBatchId = useProfileCopyFlowStore(
    (s) => s.forgetSyncStartBatchId,
  );
  const close = useProfileCopyFlowStore((s) => s.close);
  const catalog = useProvidersListForClient(
    useHostClientForHostId(sourceHostId),
    { enabled: true, subscribed: true },
  );
  const list = useProfileSyncList(sourceHostId);
  const rules = list.data?.rules ?? [];
  const { batch, setBatchId, acceptStarted, acceptResolved, acceptRetried } =
    useProfileSyncViewedBatch(sourceHostId, list);
  const { selected, profileCount } = selectedCatalogProfiles(
    catalog.data?.providers,
    chosenProviders,
  );
  const selectionTooLarge =
    profileCount * destinations.length > PROFILE_SYNC_MAX_ITEMS;
  const selection = syncSelection(
    sourceHostId,
    selected,
    destinations,
    selectionTooLarge,
  );
  const selectionKey = JSON.stringify(selection);
  const settledKey = useDebouncedValue(selectionKey, 400);
  const start = useProfileSyncStart(sourceHostId);
  const preview = useProfileSyncPreview(
    sourceHostId,
    selectionKey === settledKey && tab === "now" && batch === null
      ? selection
      : null,
  );
  const { currentPreview, previewMismatch } = syncPreviewForSelection(
    preview,
    selection,
    selectionKey === settledKey,
  );
  const startError = matchingStartError(
    start.variables,
    start.error,
    selectionKey,
    currentPreview,
  );
  const sourceName = hosts.nameFor(sourceHostId);
  const canStart =
    currentPreview !== null &&
    currentPreview.items.some((i) =>
      ["ready", "synced", "queued", "copying"].includes(i.state),
    ) &&
    !preview.isFetching &&
    !pending;
  const run = (): void => {
    if (!canStart || selection === null) return;
    setEmptyStart(null);
    setRefusedStart(null);
    const id = getSyncStartBatchId(selection, currentPreview.revision);
    start.mutate(
      {
        selection,
        revision: currentPreview.revision,
        batchId: id,
      },
      {
        onSuccess: (result, request, submitted) => {
          const refusal = startResponseRefusal(result, request, currentPreview);
          if (refusal !== null) {
            setRefusedStart({
              selectionKey,
              revision: request.revision,
              message: refusal,
            });
            return;
          }
          // A confirmed response retires the uncertain request identity.
          // Going Back and starting again is a new run, even at this revision.
          forgetSyncStartBatchId(
            request.selection,
            request.revision,
            request.batchId,
          );
          if (result.items.length === 0) {
            setEmptyStart({ selectionKey, revision: request.revision });
            void preview.refetch();
            return;
          }
          acceptStarted(result, submitted);
        },
      },
    );
  };
  return {
    sourceHostId,
    hosts,
    tab,
    setTab,
    selected,
    setSelected,
    destinations,
    setDestinations,
    setBatchId,
    close,
    catalog,
    list,
    rules,
    selection,
    selectionKey,
    settledKey,
    preview,
    currentPreview,
    previewMismatch,
    start,
    startError,
    batch,
    acceptResolved,
    acceptRetried,
    sourceName,
    canStart,
    selectionTooLarge,
    nothingStarted: matchingStartNotice(
      emptyStart,
      selectionKey,
      currentPreview,
    ),
    startRefusal: matchingStartRefusal(
      refusedStart,
      selectionKey,
      currentPreview,
    ),
    pending,
    run,
  };
}

function matchingStartError(
  request:
    | RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">
    | undefined,
  error: HostRpcError | null,
  selectionKey: string,
  preview: ProfileSyncPreview | null,
): HostRpcError | null {
  return request !== undefined &&
    JSON.stringify(request.selection) === selectionKey &&
    request.revision === preview?.revision
    ? error
    : null;
}

function matchingStartNotice(
  notice: ScopedStartNotice | null,
  selectionKey: string,
  preview: ProfileSyncPreview | null,
): boolean {
  return (
    notice !== null &&
    notice.selectionKey === selectionKey &&
    notice.revision === preview?.revision
  );
}

function matchingStartRefusal(
  refusal: ScopedStartRefusal | null,
  selectionKey: string,
  preview: ProfileSyncPreview | null,
): string | null {
  return refusal !== null && matchingStartNotice(refusal, selectionKey, preview)
    ? refusal.message
    : null;
}

function startResponseRefusal(
  batch: ProfileSyncBatch,
  request: RequestOfMethod<HostRpcRegistry, "providers.profileCopy.sync.start">,
  preview: ProfileSyncPreview,
): string | null {
  if (batch.sourceHostId !== request.selection.sourceHostId)
    return "The device returned a run for another source. Check sync history again.";
  const profiles = new Set(preview.items.map(syncItemIdentity));
  if (
    batch.batchId !== request.batchId ||
    batch.automatic ||
    batch.items.some((item) => !profiles.has(syncItemIdentity(item)))
  )
    return "The device returned a run outside this selection. Check sync history again.";
  return null;
}

function syncItemIdentity(item: ProfileSyncBatch["items"][number]): string {
  return JSON.stringify([
    item.operationId,
    item.providerId,
    item.sourceProfileId,
    item.destinationHostId,
  ]);
}

function syncPreviewForSelection(
  preview: UseQueryResult<ProfileSyncPreview, HostRpcError>,
  selection: ProfileSyncSelection | null,
  settled: boolean,
): { currentPreview: ProfileSyncPreview | null; previewMismatch: boolean } {
  if (!settled || !preview.isSuccess || selection === null)
    return { currentPreview: null, previewMismatch: false };
  const previewMismatch = !sameSyncSelection(selection, preview.data.selection);
  return {
    currentPreview: previewMismatch ? null : preview.data,
    previewMismatch,
  };
}

function sameSyncSelection(
  left: ProfileSyncSelection,
  right: ProfileSyncSelection,
): boolean {
  const sameScope =
    left.scope.kind === "all"
      ? right.scope.kind === "all"
      : right.scope.kind === "selected" &&
        sameSelectedIds(left.scope.providers, right.scope.providers);
  return (
    left.sourceHostId === right.sourceHostId &&
    sameScope &&
    sameSelectedIds(left.destinationHostIds, right.destinationHostIds)
  );
}

function sameSelectedIds(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function selectedCatalogProfiles(
  providers: readonly ProviderCliState[] | undefined,
  chosenProviders: readonly ProfileCopyWireProvider[],
): { selected: ProfileCopyWireProvider[]; profileCount: number } {
  const catalog = providers ?? [];
  const selected = chosenProviders.filter((provider) =>
    catalog.some((p) => profileCopyWireProvider(p.providerId) === provider),
  );
  const profileCount = catalog
    .filter((p) =>
      selected.some((id) => profileCopyWireProvider(p.providerId) === id),
    )
    .reduce((count, p) => count + p.profiles.length, 0);
  return { selected, profileCount };
}

function useSyncDestinations(
  sourceHostId: string,
  hosts: ProfileCopyHosts,
): {
  destinations: string[];
  setDestinations: Dispatch<SetStateAction<string[]>>;
} {
  const [chosen, setChosen] = useState<string[]>([]);
  const available = (ids: string[]): string[] =>
    ids.filter(
      (id) =>
        id !== sourceHostId && hosts.options.some((host) => host.hostId === id),
    );
  const destinations = available(chosen);
  const setDestinations: Dispatch<SetStateAction<string[]>> = (update) =>
    setChosen((current) => {
      const selected = available(current);
      return available(
        typeof update === "function" ? update(selected) : update,
      );
    });
  return { destinations, setDestinations };
}

function syncSelection(
  sourceHostId: string,
  providers: ProfileCopyWireProvider[],
  destinationHostIds: string[],
  selectionTooLarge: boolean,
): ProfileSyncSelection | null {
  if (
    providers.length === 0 ||
    destinationHostIds.length === 0 ||
    selectionTooLarge
  )
    return null;
  return {
    sourceHostId,
    // Click order must not change preview, notice or retry identity.
    scope: { kind: "selected", providers: [...providers].sort() },
    destinationHostIds: [...destinationHostIds].sort(),
  };
}
