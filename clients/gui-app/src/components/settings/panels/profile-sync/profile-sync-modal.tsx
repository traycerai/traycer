import { Fragment, useState, type ReactNode } from "react";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProfileSyncDevice,
  ProfileSyncItem,
  ProfileSyncOverview,
} from "@traycer/protocol/host/profile-sync-link-schemas";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import {
  AgentSpinningDots,
  MutedAgentSpinner,
} from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  useProfileSyncAcceptAccount,
  useProfileSyncAcceptAccountPending,
  useProfileSyncNow,
  useProfileSyncNowPending,
  useProfileSyncOverview,
  useProfileSyncRequestedKeepInSync,
  useProfileSyncSetKeepInSync,
} from "@/hooks/providers/use-profile-sync";
import {
  PROFILE_SYNC_STATUS_LABELS,
  groupProfileSyncItems,
  profileSyncDeviceSummary,
  profileSyncGuiProvider,
  profileSyncHasRetryableItems,
  profileSyncItemAction,
  profileSyncItemDetail,
  profileSyncItemKey,
  profileSyncProfileCountLabel,
  profileSyncProviderLabel,
  profileSyncStatusTone,
  type ProfileSyncDeviceReach,
  type ProfileSyncNames,
  type ProfileSyncTone,
} from "@/lib/profile-sync/profile-sync-presentation";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import { cn } from "@/lib/utils";
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";
import { useProvidersFocusStore } from "@/stores/settings/providers-focus-store";
import { useSystemTabModalActions } from "@/stores/tabs/use-system-tab-modal";

/** What a machine is called when the account's host list does not name it. */
const UNNAMED_SOURCE = "this device";
const UNNAMED_DEVICE = "Unknown device";

const TONE_CLASS: Record<ProfileSyncTone, string> = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  muted: "text-muted-foreground",
};

interface ProfileSyncDeviceRow {
  readonly hostId: string;
  readonly name: string;
  readonly reach: ProfileSyncDeviceReach;
  /** The source's record for this device; `null` until it is first synced. */
  readonly device: ProfileSyncDevice | null;
}

/** What the host directory alone says about reaching this device. */
function deviceReach(host: HostScopeOption): ProfileSyncDeviceReach {
  switch (host.health.state) {
    case "offline":
    case "stopped":
    case "not-installed":
    case "removed":
      return "offline";
    case "update-required":
      return "update-required";
    case "online":
    case "reported-reachable":
    case "restarting":
    case "unknown":
    case "viewer-offline":
      return "reachable";
  }
}

/**
 * Every other device of the account, in the directory's order, each paired
 * with the source's record for it. A device the source has a record for stays
 * listed even when the directory no longer names it, so its state is never
 * hidden; a device removed from the account with no record is not offered.
 */
function profileSyncDeviceRows(
  hosts: readonly HostScopeOption[],
  overview: ProfileSyncOverview,
  sourceHostId: string,
): readonly ProfileSyncDeviceRow[] {
  const records = new Map(
    overview.devices.map((device) => [device.hostId, device]),
  );
  const listed = hosts
    .filter(
      (host) =>
        host.hostId !== sourceHostId &&
        (host.health.state !== "removed" || records.has(host.hostId)),
    )
    .map((host): ProfileSyncDeviceRow => ({
      hostId: host.hostId,
      name: host.name,
      reach: deviceReach(host),
      device: records.get(host.hostId) ?? null,
    }));
  const listedIds = new Set(listed.map((row) => row.hostId));
  const unlisted = overview.devices
    .filter(
      (device) =>
        device.hostId !== sourceHostId && !listedIds.has(device.hostId),
    )
    .map((device): ProfileSyncDeviceRow => ({
      hostId: device.hostId,
      name: UNNAMED_DEVICE,
      reach: "reachable",
      device,
    }));
  return [...listed, ...unlisted];
}

/** A failed read as a sentence about the source. Never the host's own text. */
function overviewErrorText(error: HostRpcError, sourceName: string): string {
  return error.code === "E_HOST_UNSUPPORTED"
    ? `Update Traycer on ${sourceName} to sync profiles.`
    : `Couldn't reach ${sourceName} right now. This retries on its own.`;
}

/**
 * The Sync profiles dialog's one screen: a row per other device, the profiles
 * that need attention under it, and Done.
 *
 * It never locks. Nothing here gates closing on a request, and a request in
 * flight is shown only on the control that sent it - the work is the source
 * host's and continues with the dialog closed.
 */
export function ProfileSyncModal(props: {
  readonly sourceHostId: string;
}): ReactNode {
  const { sourceHostId } = props;
  const { hosts } = useHostOptions();
  const overview = useProfileSyncOverview(sourceHostId);
  const close = useProfileSyncModalStore((state) => state.close);
  const sourceName =
    hosts.find((host) => host.hostId === sourceHostId)?.name ?? UNNAMED_SOURCE;
  const data = overview.data;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Sync profiles</DialogTitle>
        <DialogDescription>
          {data === undefined
            ? `From ${sourceName}`
            : `From ${sourceName} · ${profileSyncProfileCountLabel(data.profileCount)}`}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-4">
        {data === undefined ? (
          <ProfileSyncUnloaded error={overview.error} sourceName={sourceName} />
        ) : (
          <ProfileSyncDevices
            sourceHostId={sourceHostId}
            sourceName={sourceName}
            overview={data}
            rows={profileSyncDeviceRows(hosts, data, sourceHostId)}
            refreshFailed={overview.isError}
          />
        )}
      </div>
      <DialogFooter>
        <Button type="button" onClick={close}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

function ProfileSyncUnloaded(props: {
  readonly error: HostRpcError | null;
  readonly sourceName: string;
}): ReactNode {
  if (props.error !== null) {
    return (
      <p role="alert" className="text-ui-sm text-muted-foreground">
        {overviewErrorText(props.error, props.sourceName)}
      </p>
    );
  }
  return (
    <div
      role="status"
      className="flex items-center gap-2 text-ui-sm text-muted-foreground"
    >
      <MutedAgentSpinner />
      Loading devices
    </div>
  );
}

function ProfileSyncDevices(props: {
  readonly sourceHostId: string;
  readonly sourceName: string;
  readonly overview: ProfileSyncOverview;
  readonly rows: readonly ProfileSyncDeviceRow[];
  /** The last poll failed; what is shown is the last answer that arrived. */
  readonly refreshFailed: boolean;
}): ReactNode {
  if (props.rows.length === 0) {
    return (
      <p className="text-ui-sm text-muted-foreground">
        No other devices on this account yet.
      </p>
    );
  }
  return (
    <>
      {props.refreshFailed ? (
        <p role="status" className="text-ui-xs text-muted-foreground">
          Couldn&apos;t refresh from {props.sourceName}. Showing the last known
          status.
        </p>
      ) : null}
      {props.rows.map((row) => (
        <ProfileSyncDeviceCard
          key={row.hostId}
          sourceHostId={props.sourceHostId}
          sourceName={props.sourceName}
          profileCount={props.overview.profileCount}
          row={row}
        />
      ))}
    </>
  );
}

function ProfileSyncDeviceCard(props: {
  readonly sourceHostId: string;
  readonly sourceName: string;
  readonly profileCount: number;
  readonly row: ProfileSyncDeviceRow;
}): ReactNode {
  const { sourceHostId, row } = props;
  const [showAll, setShowAll] = useState(false);
  const syncNow = useProfileSyncNow(sourceHostId, row.hostId);
  const setKeepInSync = useProfileSyncSetKeepInSync(sourceHostId, row.hostId);
  const syncNowPending = useProfileSyncNowPending(sourceHostId, row.hostId);
  const requestedKeepInSync = useProfileSyncRequestedKeepInSync(
    sourceHostId,
    row.hostId,
  );
  const keepInSyncPending = requestedKeepInSync !== null;
  const keepInSync = requestedKeepInSync ?? row.device?.keepInSync ?? false;
  const names: ProfileSyncNames = {
    source: props.sourceName,
    device: row.name,
  };
  const summary = profileSyncDeviceSummary({
    device: row.device,
    reach: row.reach,
    keepInSync,
    deviceName: row.name,
    profileCount: props.profileCount,
  });
  const items = row.device?.items ?? [];
  const groups = groupProfileSyncItems(items);
  const shown = showAll ? [...groups.shown, ...groups.rest] : groups.shown;
  // A followed device syncs by itself, so the button is there only for what
  // an explicit sync retries.
  const syncNowOffered = !keepInSync || profileSyncHasRetryableItems(items);
  return (
    <section
      aria-label={row.name}
      className="rounded-lg border border-border/60"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="truncate text-ui-sm font-medium text-foreground">
            {row.name}
          </h3>
          <p className="text-ui-xs text-muted-foreground">
            {summary.map((part, index) => (
              <Fragment key={part.text}>
                {index > 0 ? " · " : null}
                <span className={TONE_CLASS[part.tone]}>{part.text}</span>
              </Fragment>
            ))}
          </p>
        </div>
        {syncNowOffered ? (
          <Button
            type="button"
            size="sm"
            disabled={syncNowPending}
            onClick={() => syncNow.mutate()}
          >
            {syncNowPending ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            Sync now
          </Button>
        ) : null}
        <label className="flex items-center gap-2 text-ui-xs text-muted-foreground">
          {keepInSyncPending ? <MutedAgentSpinner /> : null}
          Keep in sync
          <Switch
            aria-label={`Keep ${row.name} in sync`}
            checked={keepInSync}
            disabled={keepInSyncPending}
            onCheckedChange={(enabled) => setKeepInSync.mutate({ enabled })}
          />
        </label>
      </div>
      {items.length === 0 ? null : (
        <div className="border-t border-border/60 px-3.5 pt-1 pb-2.5">
          {shown.length === 0 ? null : (
            <ul className="flex flex-col divide-y divide-border/40">
              {shown.map((item) => (
                <ProfileSyncItemRow
                  key={profileSyncItemKey(item)}
                  sourceHostId={sourceHostId}
                  destinationHostId={row.hostId}
                  names={names}
                  item={item}
                />
              ))}
            </ul>
          )}
          {groups.rest.length === 0 ? null : (
            <Button
              type="button"
              variant="link"
              size="inline-xs"
              className="mt-1.5"
              aria-expanded={showAll}
              onClick={() => setShowAll((current) => !current)}
            >
              {showAll ? "Show fewer" : `Show all ${String(items.length)}`}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function ProfileSyncItemRow(props: {
  readonly sourceHostId: string;
  readonly destinationHostId: string;
  readonly names: ProfileSyncNames;
  readonly item: ProfileSyncItem;
}): ReactNode {
  const { item, names } = props;
  const detail = profileSyncItemDetail(item, names);
  const action = profileSyncItemAction(item);
  return (
    <li className="flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-ui-xs">
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-foreground">
          {profileSyncProviderLabel(item.providerId)} · {item.name}
        </div>
        {detail === null ? null : (
          <div className="text-muted-foreground">{detail}</div>
        )}
      </div>
      <span
        className={cn(
          "shrink-0",
          TONE_CLASS[profileSyncStatusTone(item.status)],
        )}
      >
        {PROFILE_SYNC_STATUS_LABELS[item.status]}
      </span>
      {action === "sign-in" ? (
        <ProfileSyncSignInButton
          sourceHostId={props.sourceHostId}
          sourceName={names.source}
          item={item}
        />
      ) : null}
      {action === "accept-account" ? (
        <ProfileSyncAcceptAccountButton
          sourceHostId={props.sourceHostId}
          destinationHostId={props.destinationHostId}
          item={item}
        />
      ) : null}
    </li>
  );
}

/**
 * Opens the source profile's ordinary sign-in: Settings ▸ Providers on the
 * source, on that profile, through the same one-shot focus intent every other
 * sign-in deep link uses. Providers drops its body while that intent moves its
 * host scope, so the dialog closes first - nothing here is lost by it.
 */
function ProfileSyncSignInButton(props: {
  readonly sourceHostId: string;
  readonly sourceName: string;
  readonly item: ProfileSyncItem;
}): ReactNode {
  const { openSettings } = useSystemTabModalActions();
  const close = useProfileSyncModalStore((state) => state.close);
  const openSignIn = (): void => {
    const focus = useProvidersFocusStore.getState();
    focus.setProfileFocus({
      harnessId: providerIdToGuiHarnessId(
        profileSyncGuiProvider(props.item.providerId),
      ),
      hostId: props.sourceHostId,
      profileId: props.item.sourceProfileId,
      startSignIn: true,
    });
    focus.setFocusTab("usage");
    close();
    openSettings({
      section: "providers",
      resetToGeneral: false,
      tab: null,
      draft: null,
      // The providers focus set above carries the source host.
      hostId: null,
    });
  };
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="max-w-full"
      onClick={openSignIn}
    >
      <span className="truncate">Sign in on {props.sourceName}</span>
    </Button>
  );
}

function ProfileSyncAcceptAccountButton(props: {
  readonly sourceHostId: string;
  readonly destinationHostId: string;
  readonly item: ProfileSyncItem;
}): ReactNode {
  const { sourceHostId, destinationHostId, item } = props;
  const acceptAccount = useProfileSyncAcceptAccount(
    sourceHostId,
    destinationHostId,
    item.providerId,
    item.sourceProfileId,
  );
  const pending = useProfileSyncAcceptAccountPending(
    sourceHostId,
    destinationHostId,
    item.providerId,
    item.sourceProfileId,
  );
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={pending}
      onClick={() => acceptAccount.mutate()}
    >
      {pending ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      Sync the new account
    </Button>
  );
}
