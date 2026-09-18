import { useId, useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { PROFILE_COPY_MAX_DESTINATIONS } from "@traycer/protocol/host/profile-copy-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useProfileCopyPreviewQuery } from "@/hooks/providers/profile-copy/use-profile-copy-queries";
import { useProfileCopyStartMutation } from "@/hooks/providers/profile-copy/use-profile-copy-operation-mutations";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  isRoutableDisposition,
  profileCopyGuiProvider,
  profileCopyPreviewRecord,
  type ProfileCopyPreviewRecord,
  type ProfileCopyPreviewResponse,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import {
  presentProfileCopyPreview,
  type ProfileCopyNames,
} from "@/lib/profile-copy/profile-copy-presentation";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyOperationsStore } from "@/stores/settings/profile-copy-operations-store";
import { ProfileCopyBadge } from "./profile-copy-badge";
import {
  profileCopyProviderLabel,
  profileCopyRequestErrorText,
  useProfileCopySettingsNavigation,
  useProfileCopySourceProfile,
  type ProfileCopyHosts,
} from "./profile-copy-shared";
import { recordProfileCopyStart } from "./profile-copy-source-operation";

/** Selection settles for this long before the source is asked. */
const PREVIEW_DEBOUNCE_MS = 400;
/** Host ids are `[A-Za-z0-9_-]+` on the wire, so a comma joins them unambiguously. */
const SELECTION_SEPARATOR = ",";

/**
 * Why the last start created nothing, until the selection changes:
 *
 * - `refused`: the source refused the request outright (`E_INVALID_ARGUMENT`);
 * - `nothing-started`: the source answered with no outcomes - no destination
 *   survived its start-time re-check, so nothing was created anywhere.
 */
type NewCopyStartNotice = "refused" | "nothing-started";

interface NewCopySelection {
  /** Click order, which is also the preview's (and the start's) list order. */
  readonly selected: readonly string[];
  /** The settled selection the preview was asked for. */
  readonly previewIds: string[];
  readonly preview: UseQueryResult<ProfileCopyPreviewResponse, HostRpcError>;
  /** The answer for the CURRENT selection, or `null`. */
  readonly previewData: ProfileCopyPreviewResponse | null;
  readonly records: readonly ProfileCopyPreviewRecord[];
  readonly routableCount: number;
  readonly startNotice: NewCopyStartNotice | null;
  readonly noteStart: (notice: NewCopyStartNotice) => void;
  readonly toggle: (hostId: string, checked: boolean) => void;
}

function useNewCopySelection(
  sourceHostId: string,
  provider: ProfileCopyWireProvider,
  sourceProfileId: string,
): NewCopySelection {
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [startNotice, setStartNotice] = useState<NewCopyStartNotice | null>(
    null,
  );
  const selectionKey = selected.join(SELECTION_SEPARATOR);
  const debouncedKey = useDebouncedValue(selectionKey, PREVIEW_DEBOUNCE_MS);
  const previewIds =
    debouncedKey.length === 0 ? [] : debouncedKey.split(SELECTION_SEPARATOR);
  const preview = useProfileCopyPreviewQuery(
    sourceHostId,
    previewIds.length === 0
      ? null
      : {
          sourceHostId,
          sourceProfileId,
          providerId: provider,
          destinationHostIds: previewIds,
        },
  );
  // The answer for the CURRENT selection only: while a new selection is
  // settling, or a different list is being asked, nothing here is current.
  const previewData =
    selected.length > 0 && debouncedKey === selectionKey && preview.isSuccess
      ? preview.data
      : null;
  const records: readonly ProfileCopyPreviewRecord[] =
    previewData === null
      ? []
      : previewData.destinations.map(profileCopyPreviewRecord);
  const routableCount = records.filter((record) =>
    isRoutableDisposition(record.disposition),
  ).length;

  return {
    selected,
    previewIds,
    preview,
    previewData,
    records,
    routableCount,
    startNotice,
    noteStart: setStartNotice,
    toggle: (hostId, checked) => {
      setStartNotice(null);
      setSelected((current) =>
        checked
          ? [...current.filter((id) => id !== hostId), hostId]
          : current.filter((id) => id !== hostId),
      );
    },
  };
}

function newCopyFooterStatus(input: {
  readonly selectedCount: number;
  readonly previewSettled: boolean;
  readonly previewFailed: boolean;
  readonly routableCount: number;
}): string {
  const { selectedCount, routableCount } = input;
  if (input.previewFailed) return "";
  if (selectedCount === 0) return "Choose the devices to copy to.";
  if (!input.previewSettled) return "Checking the selected devices…";
  if (routableCount === 0) {
    return "None of the selected devices can receive this profile yet.";
  }
  return `${routableCount} of ${selectedCount} selected ${selectedCount === 1 ? "device" : "devices"} can receive this profile.`;
}

function copyButtonLabel(routableCount: number): string {
  if (routableCount === 0) return "Copy";
  return `Copy to ${routableCount} ${routableCount === 1 ? "device" : "devices"}`;
}

function ProfileCopyNewCopyNotices(props: {
  readonly sourceName: string;
  readonly atCapacity: boolean;
  readonly previewError: HostRpcError | null;
  readonly startNotice: NewCopyStartNotice | null;
  readonly startError: HostRpcError | null;
}): ReactNode {
  const { sourceName, previewError, startError } = props;
  return (
    <>
      {props.atCapacity ? (
        <p className="text-ui-xs text-muted-foreground">
          A profile can be copied to at most {PROFILE_COPY_MAX_DESTINATIONS}{" "}
          devices at once.
        </p>
      ) : null}
      {previewError !== null ? (
        <p className="text-ui-xs text-destructive" role="alert">
          {previewError.code === "E_INVALID_ARGUMENT"
            ? `This profile no longer exists on ${sourceName}.`
            : profileCopyRequestErrorText(previewError, sourceName)}
        </p>
      ) : null}
      {props.startNotice === "refused" ? (
        <p className="text-ui-xs text-warning-foreground" role="status">
          Something changed since the check. Review the devices again.
        </p>
      ) : null}
      {props.startNotice === "nothing-started" ? (
        <p className="text-ui-xs text-warning-foreground" role="status">
          Nothing was started: none of the selected devices can receive this
          profile right now.
        </p>
      ) : null}
      {startError !== null && startError.code !== "E_INVALID_ARGUMENT" ? (
        <p className="text-ui-xs text-destructive" role="alert">
          {profileCopyRequestErrorText(startError, sourceName)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Pick devices, see what each one can do, start.
 *
 * The preview is asked for EXACTLY the selected list: its revision covers the
 * list, so the start sends the same list back. Destinations the source says it
 * cannot reach, or cannot sign in, are started along with the rest and get no
 * attempt - the host creates nothing for them - and their preview answer is
 * what the operation keeps showing for them.
 */
export function ProfileCopyNewCopy(props: {
  readonly sourceHostId: string;
  readonly provider: ProfileCopyWireProvider;
  readonly sourceProfileId: string;
  readonly hosts: ProfileCopyHosts;
}): ReactNode {
  const { sourceHostId, provider, sourceProfileId, hosts } = props;
  const sourceName = hosts.nameFor(sourceHostId);
  const providerLabel = profileCopyProviderLabel(provider);
  const sourceProfile = useProfileCopySourceProfile(
    sourceHostId,
    provider,
    sourceProfileId,
  );
  const profileName = sourceProfile.profileName;
  const candidates = hosts.options.filter(
    (host) => host.hostId !== sourceHostId,
  );
  const selection = useNewCopySelection(
    sourceHostId,
    provider,
    sourceProfileId,
  );
  const { selected, preview, previewData, records, routableCount } = selection;
  const previewSettled = previewData !== null;

  const start = useProfileCopyStartMutation(sourceHostId);
  const removeHandle = useProfileCopyOperationsStore((state) => state.remove);
  const openView = useProfileCopyFlowStore((state) => state.open);
  const closeFlow = useProfileCopyFlowStore((state) => state.close);
  const navigation = useProfileCopySettingsNavigation();

  const onStart = (): void => {
    if (previewData === null) return;
    const previewRevision = previewData.previewRevision;
    const previewIds = selection.previewIds;
    // Minted BEFORE dispatch, and the handle recorded first: a lost answer
    // reopens from Recent copies and can send this same request again.
    const operationId = crypto.randomUUID();
    recordProfileCopyStart({
      operationId,
      sourceHostId,
      sourceProfileId,
      providerId: provider,
      destinationHostIds: previewIds,
      previewRevision,
      previewRecords: records,
    });
    start.mutate(
      {
        sourceHostId,
        sourceProfileId,
        providerId: provider,
        destinationHostIds: previewIds,
        operationId,
        previewRevision,
      },
      {
        onSuccess: (response) => {
          if (response.outcomes.length === 0) {
            // The start hook has already forgotten the handle. Stay on the
            // device list and re-check it, so each device says why.
            selection.noteStart("nothing-started");
            void preview.refetch();
            return;
          }
          Analytics.getInstance().track(AnalyticsEvent.ProfileCopyStarted, {
            provider: profileCopyGuiProvider(provider),
            destination_count: routableCount,
          });
          openView({ kind: "operation", operationId });
        },
        onError: (error) => {
          if (error.code === "E_INVALID_ARGUMENT") {
            // Refused outright - stale preview, a changed request, a missing
            // profile, no capacity: nothing was created, so nothing to keep.
            removeHandle(operationId);
            selection.noteStart("refused");
            void preview.refetch();
            return;
          }
          // Anything else is ambiguous: the copy may have started. The
          // operation view reads the source and offers "Start again" if not.
          openView({ kind: "operation", operationId });
        },
      },
    );
  };

  const names = (destinationHostId: string): ProfileCopyNames => ({
    source: sourceName,
    destination: hosts.nameFor(destinationHostId),
    provider: providerLabel,
    profile: profileName,
  });

  const footerStatus = newCopyFooterStatus({
    selectedCount: selected.length,
    previewSettled,
    previewFailed: preview.isError,
    routableCount,
  });
  const atCapacity = selected.length >= PROFILE_COPY_MAX_DESTINATIONS;
  const checking = !previewSettled && !preview.isError;

  return (
    <>
      <DialogHeader className="gap-1.5">
        <DialogTitle>Copy “{profileName}” to other devices</DialogTitle>
        <DialogDescription>
          Copies the profile&apos;s name, color and whether agents may use it.
          Where Traycer can, it signs the device in for you; otherwise you
          finish signing in on that device. Nothing on {sourceName} changes, and
          each copy is independent afterwards.
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
        {sourceProfile.missing ? (
          <p className="text-ui-xs text-destructive">
            This profile no longer exists on {sourceName}.
          </p>
        ) : null}
        {candidates.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            Add another device to your account to copy profiles to it.
          </p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Devices">
            {candidates.map((host) => {
              const isSelected = selected.includes(host.hostId);
              const record = isSelected
                ? records.find(
                    (candidate) => candidate.destinationHostId === host.hostId,
                  )
                : undefined;
              return (
                <ProfileCopyDestinationCandidate
                  key={host.hostId}
                  host={host}
                  selected={isSelected}
                  disabled={!isSelected && atCapacity}
                  record={record ?? null}
                  checking={isSelected ? checking : false}
                  names={names(host.hostId)}
                  checkAgainPending={preview.isFetching}
                  onToggle={(checked) => selection.toggle(host.hostId, checked)}
                  onCheckAgain={() => void preview.refetch()}
                  onSetUp={() =>
                    navigation.openDestinationSetup({
                      destinationHostId: host.hostId,
                      provider,
                    })
                  }
                />
              );
            })}
          </ul>
        )}
        <ProfileCopyNewCopyNotices
          sourceName={sourceName}
          atCapacity={atCapacity}
          previewError={preview.isError ? preview.error : null}
          startNotice={selection.startNotice}
          startError={start.isError ? start.error : null}
        />
      </div>
      <DialogFooter className="gap-2">
        {footerStatus.length > 0 ? (
          <p className="mr-auto self-center text-ui-xs text-muted-foreground">
            {footerStatus}
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={closeFlow}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            !previewSettled ||
            routableCount === 0 ||
            !sourceProfile.available ||
            start.isPending
          }
          onClick={onStart}
        >
          {start.isPending ? <MutedAgentSpinner /> : null}
          {copyButtonLabel(routableCount)}
        </Button>
      </DialogFooter>
    </>
  );
}

function ProfileCopyDestinationCandidate(props: {
  readonly host: HostScopeOption;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly record: ProfileCopyPreviewRecord | null;
  readonly checking: boolean;
  readonly names: ProfileCopyNames;
  readonly checkAgainPending: boolean;
  readonly onToggle: (checked: boolean) => void;
  readonly onCheckAgain: () => void;
  readonly onSetUp: () => void;
}): ReactNode {
  const id = useId();
  const presentation =
    props.record === null
      ? null
      : presentProfileCopyPreview(props.record, props.names);
  const detail = [
    props.host.platform,
    props.host.isLocalMachine ? "this device" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Checkbox
          id={id}
          checked={props.selected}
          disabled={props.disabled}
          onCheckedChange={(value) => props.onToggle(value === true)}
        />
        <label
          htmlFor={id}
          className="flex min-w-0 flex-auto cursor-pointer items-baseline gap-2 select-none"
        >
          <span className="min-w-0 truncate text-ui-sm font-medium text-foreground">
            {props.host.name}
          </span>
          {detail.length > 0 ? (
            <span className="shrink-0 text-ui-xs text-muted-foreground">
              {detail}
            </span>
          ) : null}
        </label>
        {presentation !== null ? (
          <ProfileCopyBadge
            tone={presentation.tone}
            label={presentation.badge}
          />
        ) : null}
      </div>
      {props.checking ? (
        <div className="flex items-center gap-2 pl-6 text-ui-xs text-muted-foreground">
          <MutedAgentSpinner />
          Checking {props.host.name}…
        </div>
      ) : null}
      {presentation !== null ? (
        <div className="flex flex-col gap-1 pl-6 text-ui-xs text-muted-foreground">
          <p>{presentation.body}</p>
          {presentation.note !== null ? <p>{presentation.note}</p> : null}
          {presentation.remedy !== null ? (
            <div className="flex flex-wrap gap-2 pt-0.5">
              {presentation.remedy === "set-up" ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={props.onSetUp}
                >
                  Set up on {props.host.name}
                </Button>
              ) : null}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={props.checkAgainPending}
                onClick={props.onCheckAgain}
              >
                {props.checkAgainPending ? <MutedAgentSpinner /> : null}
                Check again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
