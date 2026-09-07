import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  Check,
  Download,
  RotateCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useProviderPackVersionManagerSupport } from "./provider-pack-version-manager-capability";
import {
  createVersionManagerPanelToken,
  registerVersionManagerPanel,
} from "./provider-pack-version-manager-presence";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersInstallPackVersion } from "@/hooks/providers/use-providers-install-pack-version-mutation";
import { useProvidersRefreshPackDiscovery } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";
import { useProvidersRemovePackVersion } from "@/hooks/providers/use-providers-remove-pack-version-mutation";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { cn } from "@/lib/utils";
import {
  comparePackVersionsDescending,
  formatSharedWithProvidersLine,
  installPackVersionRefusalMessage,
  isBlockingCertification,
  packDiscoveryCheckOutcomeNotice,
  refreshPackDiscoveryRefusalMessage,
  removeResultUserMessage,
  updateBannerDownloadEligibility,
  packVersionUseRefusalMessage,
  versionDeleteEligibility,
  versionDownloadEligibility,
  versionInstallFetchLabel,
  versionRowChip,
  versionShowsDeleteAction,
  versionShowsInstallFetchAction,
  versionTroubleLine,
  versionUseEligibility,
  type PackDiscoveryCheckNotice,
  type VersionDeleteEligibility,
  type VersionDownloadEligibility,
  type VersionRowChip,
  type VersionUseEligibility,
} from "./provider-pack-version-manager-model";

const CLEAR_PIN_PENDING_KEY = "__auto__";

/** Do not ambiently re-read the globally active host - the settings surface can display one host while another
 * is active. */
export type ProviderPackVersionManagerPanelProps = {
  /** Null when the scope has no host yet - treated like capability-unknown (pending), never as "unsupported". */
  readonly hostId: string | null;
  readonly packId: string;
  /** Not a provider id - shared packs have one name that is not any single provider. */
  readonly packDisplayName: string;
  readonly managedVersions: ProviderManagedVersions;
};

type RowNotice = {
  readonly version: string;
  readonly kind: "info" | "error";
  readonly message: string;
};

type BannerNotice = {
  readonly kind: "error";
  readonly message: string;
};

/** The row whose Delete is armed - identified by where it is, not just which version, so the arming cannot
 * outlive the host and pack it was made on. */
type ArmedDelete = {
  readonly hostId: string | null;
  readonly packId: string;
  readonly version: string;
};

/** The armed version, but only while the panel still shows the host and pack it was armed on. */
function armedVersionWithin(
  armed: ArmedDelete | null,
  hostId: string | null,
  packId: string,
): string | null {
  if (armed === null) return null;
  if (armed.hostId !== hostId || armed.packId !== packId) return null;
  return armed.version;
}

/** An update check is the longest-lived request on this surface by a wide margin: it can join the host's
 * in-flight discovery tick, so one press is budgeted `PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS`. */
type CheckIdentity = {
  readonly hostId: string | null;
  readonly packId: string;
};

function checkIdentityMatches(
  identity: CheckIdentity | null,
  hostId: string | null,
  packId: string,
): boolean {
  if (identity === null) return false;
  return identity.hostId === hostId && identity.packId === packId;
}

/** A module-level predicate rather than an inline `&&` for the same reason `armedVersionWithin` is one: the
 * panel body is at its complexity ceiling, and this is a fact about an identity, not about rendering. */
function checkIsPendingWithin(
  identity: CheckIdentity | null,
  isPending: boolean,
  hostId: string | null,
  packId: string,
): boolean {
  if (!isPending) return false;
  return checkIdentityMatches(identity, hostId, packId);
}

/** The check notice, but only while the panel still shows the host and pack it answers about. */
function checkNoticeWithin(
  scoped: ScopedCheckNotice | null,
  hostId: string | null,
  packId: string,
): PackDiscoveryCheckNotice | null {
  if (scoped === null) return null;
  if (!checkIdentityMatches(scoped.identity, hostId, packId)) return null;
  return scoped.notice;
}

type ScopedCheckNotice = {
  readonly identity: CheckIdentity;
  readonly notice: PackDiscoveryCheckNotice;
};

/** It is opened from one specific CLI's version cell, so naming that CLI again is the widest, loudest element
 * on the surface saying the one thing the user cannot have forgotten. */
export function ProviderPackVersionManagerPanel(
  props: ProviderPackVersionManagerPanelProps,
): JSX.Element {
  const { hostId, packId, packDisplayName, managedVersions } = props;
  // Gate against the settings-scoped host only. The hook already returns null
  // when hostId is null (no handshake possible yet).
  const methodSupport = useProviderPackVersionManagerSupport(hostId);
  // Gated here rather than through PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS so it can hide alone - see
  // that array's doc for why it is not a member.
  const canCheckForUpdates = useHostSupportsMethod(
    hostId,
    "providers.refreshPackDiscovery",
  );

  // A recomputation for any other reason degrades the same way - toward a toast, never toward silence.
  const panelToken = useMemo(
    () => createVersionManagerPanelToken(packId),
    [packId],
  );

  const install = useProvidersInstallPackVersion(panelToken);
  const remove = useProvidersRemovePackVersion(panelToken);
  const useVersion = useProvidersUsePackVersion(panelToken);
  const setPolicy = useProvidersSetPackPolicy();
  const check = useProvidersRefreshPackDiscovery(panelToken);

  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const [bannerNotice, setBannerNotice] = useState<BannerNotice | null>(null);
  // `bannerNotice` renders only inside `UpdateAvailableBanner`, which only mounts when `updateAvailable !==
  // null`.
  const [pinNotice, setPinNotice] = useState<BannerNotice | null>(null);
  // Footer-scoped, and the only notice on this surface that can be good news: a check answers neutrally as often
  // as not, so unlike the row and banner notices it carries a tone rather than being error-only.
  const [checkNotice, setCheckNotice] = useState<ScopedCheckNotice | null>(
    null,
  );
  // The identity the in-flight check was dispatched for, so `check.isPending` - which belongs to the mutation,
  // not to any one pack - only ever disables the button that started it.
  const [checkInFlight, setCheckInFlight] = useState<CheckIdentity | null>(
    null,
  );
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  // Deliberately not a timeout - a self-disarming control is untestable without fake timers and, worse, can
  // disarm between a user deciding and clicking.
  const [armedDelete, setArmedDelete] = useState<ArmedDelete | null>(null);
  const armedVersion = armedVersionWithin(armedDelete, hostId, packId);

  // The pending and unsupported branches below return early, before any notice is drawn, so a registration there
  // would claim an outcome it cannot show.
  const canRenderOutcome = hostId !== null && methodSupport === true;
  useEffect(() => {
    if (!canRenderOutcome) return undefined;
    return registerVersionManagerPanel(panelToken);
  }, [canRenderOutcome, panelToken]);

  const sharedLine = formatSharedWithProvidersLine(
    managedVersions.sharedWithProviders,
  );
  const updateAvailable = managedVersions.updateAvailable;
  const bannerDownload =
    updateAvailable === null
      ? null
      : updateBannerDownloadEligibility(
          managedVersions.available,
          updateAvailable.version,
        );

  // Runs at the top of every action. Disarming the delete here is what keeps
  // an armed row from surviving the user's attention moving elsewhere.
  const clearNotice = useCallback(() => {
    setRowNotice(null);
    setBannerNotice(null);
    setPinNotice(null);
    setCheckNotice(null);
    setArmedDelete(null);
  }, []);

  const onToggleAutoDownload = useCallback(
    (next: boolean) => {
      clearNotice();
      setPolicy.mutate({ packId, autoDownload: next });
    },
    [clearNotice, packId, setPolicy],
  );

  // Both arms land here rather than only the refusal, because an outcome is the only thing this action produces
  // - a successful check with nothing to say would otherwise look like a button that did nothing.
  const onCheckForUpdates = useCallback(() => {
    clearNotice();
    // Captured at dispatch, not read at delivery: by the time this answers, `hostId` and `packId` may name a
    // different panel (see `CheckIdentity`).
    const identity: CheckIdentity = { hostId, packId };
    setCheckInFlight(identity);
    check.mutate(
      { packId },
      {
        // Clears the slot only while it still holds this dispatch, so a callback that no longer owns it cannot
        // re-enable a button whose check is still running.
        onSettled: () =>
          setCheckInFlight((current) =>
            current === identity ? null : current,
          ),
        onSuccess: (response) => {
          setCheckNotice({
            identity,
            notice: response.result.ok
              ? packDiscoveryCheckOutcomeNotice(response.result.outcome)
              : {
                  kind: "error",
                  message: refreshPackDiscoveryRefusalMessage(
                    response.result.code,
                  ),
                },
          });
        },
      },
    );
  }, [check, clearNotice, hostId, packId]);

  const onDownload = useCallback(
    (version: string) => {
      clearNotice();
      setPendingVersion(version);
      const hasRow = managedVersions.available.some(
        (entry) => entry.version === version,
      );
      install.mutate(
        { packId, version },
        {
          onSettled: () => setPendingVersion(null),
          onSuccess: (response) => {
            if (!response.result.ok) {
              const message = installPackVersionRefusalMessage(
                response.result.code,
              );
              if (hasRow) {
                setRowNotice({ version, kind: "error", message });
              } else {
                // Durable banner may name a version with no row - surface on the banner, not a phantom row notice.
                setBannerNotice({ kind: "error", message });
              }
            }
          },
        },
      );
    },
    [clearNotice, install, managedVersions.available, packId],
  );

  const onUse = useCallback(
    (version: string) => {
      clearNotice();
      setPendingVersion(version);
      useVersion.mutate(
        { packId, version },
        {
          onSettled: () => setPendingVersion(null),
          // Refusal only. The success confirmation is owned by the hook, so it
          // still reaches the user when this popover closes mid-flight.
          onSuccess: (response) => {
            if (response.result.ok) return;
            setRowNotice({
              version,
              kind: "error",
              message: packVersionUseRefusalMessage(response.result.code),
            });
          },
        },
      );
    },
    [clearNotice, packId, useVersion],
  );

  const onClearPin = useCallback(() => {
    clearNotice();
    setPendingVersion(CLEAR_PIN_PENDING_KEY);
    useVersion.mutate(
      { packId, version: null },
      {
        onSettled: () => setPendingVersion(null),
        // Refusal only; the hook owns the success confirmation.
        onSuccess: (response) => {
          if (response.result.ok) return;
          // Not the update banner either: that one only mounts when an update is pending.
          setPinNotice({
            kind: "error",
            message: packVersionUseRefusalMessage(response.result.code),
          });
        },
      },
    );
  }, [clearNotice, packId, useVersion]);

  // First click on the trash: arm this row and clear whatever else was showing.
  // `clearNotice` disarms, so the set has to follow it rather than precede it.
  const onArmDelete = useCallback(
    (version: string) => {
      clearNotice();
      setArmedDelete({ hostId, packId, version });
    },
    [clearNotice, hostId, packId],
  );

  const onDelete = useCallback(
    (version: string) => {
      clearNotice();
      setPendingVersion(version);
      remove.mutate(
        { packId, version },
        {
          onSettled: () => setPendingVersion(null),
          onSuccess: (response) => {
            if (!response.result.ok) {
              const message = removeResultUserMessage(response.result);
              setRowNotice({
                version,
                kind:
                  response.result.code === "deferred-locked" ? "info" : "error",
                message,
              });
            }
          },
        },
      );
    },
    [clearNotice, packId, remove],
  );

  // hostId null OR support null: absence of knowledge, not evidence of absence.
  if (hostId === null || methodSupport === null) {
    return (
      <div
        data-testid="provider-pack-version-manager-pending"
        data-pack-id={packId}
        className="flex w-full items-center gap-2 px-4 py-3 text-ui-sm text-muted-foreground"
        aria-busy="true"
        aria-label={`${packDisplayName} versions loading`}
      >
        <MutedAgentSpinner />
        <span>Checking host support for version management…</span>
      </div>
    );
  }

  if (!methodSupport) {
    return (
      <div
        data-testid="provider-pack-version-manager-unsupported"
        data-pack-id={packId}
        className="w-full px-4 py-3 text-ui-sm text-muted-foreground"
        role="status"
      >
        Managing managed CLI versions requires a newer Traycer host. The
        provider table still works; update this host to download, switch, or
        delete individual versions.
      </div>
    );
  }

  const rows = [...managedVersions.available].sort((a, b) =>
    comparePackVersionsDescending(a.version, b.version),
  );

  // `check.isPending` is deliberately not a member. Locking Download / Use / Delete and the auto-download switch
  // for that long - over a read - is the wrong trade.
  const anyPending =
    install.isPending ||
    remove.isPending ||
    useVersion.isPending ||
    setPolicy.isPending;

  // Both scoped to the identity that dispatched the check, so a request still in flight for another host or pack
  // neither speaks for this one nor holds its button down.
  const visibleCheckNotice = checkNoticeWithin(checkNotice, hostId, packId);
  const checkPendingHere = checkIsPendingWithin(
    checkInFlight,
    check.isPending,
    hostId,
    packId,
  );

  return (
    <section
      data-testid="provider-pack-version-manager"
      data-pack-id={packId}
      data-host-id={hostId}
      // `min-h-0` so the list below can actually scroll inside a height-capped container instead of forcing this
      // section past it.
      className="flex w-full min-h-0 flex-col overflow-hidden"
      aria-label={`${packDisplayName} versions`}
    >
      <VersionManagerBanners
        sharedLine={sharedLine}
        pinnedVersion={managedVersions.pinnedVersion}
        pinNotice={pinNotice}
        clearPinPending={
          pendingVersion === CLEAR_PIN_PENDING_KEY && useVersion.isPending
        }
        actionsDisabled={anyPending}
        onClearPin={onClearPin}
      />

      {updateAvailable !== null && bannerDownload !== null ? (
        <UpdateAvailableBanner
          version={updateAvailable.version}
          canDownload={bannerDownload.allowed}
          disabledReason={bannerDownload.allowed ? null : bannerDownload.reason}
          notice={bannerNotice}
          downloadPending={
            pendingVersion === updateAvailable.version && install.isPending
          }
          actionsDisabled={anyPending}
          onDownload={onDownload}
        />
      ) : null}

      {/* Capped so the list shows about four rows and scrolls the rest, instead of growing to whatever the popover's
         own `max-h` allows. A cap on a row boundary would look like the list simply ends. */}
      <ul className="flex max-h-[min(45vh,10.5rem)] w-full min-h-0 flex-col overflow-y-auto">
        {rows.map((row) => (
          <VersionRow
            key={row.version}
            row={row}
            notice={
              rowNotice !== null && rowNotice.version === row.version
                ? rowNotice
                : null
            }
            deleteArmed={armedVersion === row.version}
            downloadPending={
              pendingVersion === row.version && install.isPending
            }
            usePending={pendingVersion === row.version && useVersion.isPending}
            deletePending={pendingVersion === row.version && remove.isPending}
            actionsDisabled={anyPending}
            onDownload={onDownload}
            onUse={onUse}
            onArmDelete={onArmDelete}
            onDelete={onDelete}
          />
        ))}
        {rows.length === 0 ? (
          <li className="px-4 py-6 text-center text-ui-sm text-muted-foreground">
            No versions listed for this pack yet.
          </li>
        ) : null}
      </ul>

      <VersionManagerFooter
        autoDownload={managedVersions.autoDownload}
        policyPending={setPolicy.isPending}
        canCheckForUpdates={canCheckForUpdates}
        checkPending={checkPendingHere}
        checkDisabled={anyPending || checkPendingHere}
        checkNotice={visibleCheckNotice}
        onToggleAutoDownload={onToggleAutoDownload}
        onCheckForUpdates={onCheckForUpdates}
      />
    </section>
  );
}

/** That is the point of it having replaced a header: a header is chrome and is always there, whereas each of
 * these is a fact that is only sometimes worth a line. */
function VersionManagerBanners(props: {
  readonly sharedLine: string | null;
  readonly pinnedVersion: string | null;
  readonly pinNotice: BannerNotice | null;
  readonly clearPinPending: boolean;
  readonly actionsDisabled: boolean;
  readonly onClearPin: () => void;
}): JSX.Element | null {
  const hasPin = props.pinnedVersion !== null;
  if (props.sharedLine === null && !hasPin && props.pinNotice === null) {
    return null;
  }

  return (
    <div className="flex w-full shrink-0 flex-col gap-2 border-b border-border bg-foreground/5 px-4 py-2.5">
      {props.sharedLine !== null ? (
        <p
          data-testid="provider-pack-shared-line"
          className="text-ui-xs text-muted-foreground"
        >
          {props.sharedLine}
        </p>
      ) : null}
      {props.pinnedVersion !== null ? (
        <div
          data-testid="provider-pack-pinned-banner"
          className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-ui-xs text-muted-foreground">
            Pinned to{" "}
            <span className="font-medium text-foreground">
              {props.pinnedVersion}
            </span>
            {" · "}
            newer versions notify only until you switch or clear the pin
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="provider-pack-clear-pin"
            disabled={props.actionsDisabled}
            onClick={props.onClearPin}
          >
            Use latest automatically
            {props.clearPinPending ? <MutedAgentSpinner /> : null}
          </Button>
        </div>
      ) : null}
      {props.pinNotice !== null ? (
        <p
          data-testid="provider-pack-pin-notice"
          className="text-ui-xs text-destructive"
        >
          {props.pinNotice.message}
        </p>
      ) : null}
    </div>
  );
}

/** Outside the scrolling `<ul>` rather than `position: sticky` inside it: the list is a sibling that scrolls
 * its own overflow. */
function VersionManagerFooter(props: {
  readonly autoDownload: boolean;
  readonly policyPending: boolean;
  readonly canCheckForUpdates: boolean;
  readonly checkPending: boolean;
  readonly checkDisabled: boolean;
  readonly checkNotice: PackDiscoveryCheckNotice | null;
  readonly onToggleAutoDownload: (next: boolean) => void;
  readonly onCheckForUpdates: () => void;
}): JSX.Element {
  return (
    <div className="flex w-full shrink-0 flex-col gap-1.5 border-t border-border bg-foreground/5 px-4 py-2.5 text-ui-xs text-muted-foreground">
      {/* Wrapping drops the label to a second line instead; the right-edge clustering below is unchanged whenever
         both do fit. */}
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2">
        {props.canCheckForUpdates ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="provider-pack-discovery-check"
            disabled={props.checkDisabled}
            onClick={props.onCheckForUpdates}
          >
            {props.checkPending ? <MutedAgentSpinner /> : null}
            Check for updates
          </Button>
        ) : null}
        <label
          className={cn(
            "flex cursor-pointer items-center gap-2",
            props.canCheckForUpdates
              ? "ml-auto shrink-0"
              : "w-full justify-between",
          )}
        >
          <span>Auto-download updates</span>
          {props.policyPending ? <MutedAgentSpinner /> : null}
          <Switch
            checked={props.autoDownload}
            onCheckedChange={props.onToggleAutoDownload}
            disabled={props.policyPending}
            aria-label="Auto-download updates"
          />
        </label>
      </div>
      {props.checkNotice !== null ? (
        // `aria-hidden` because the permanently mounted live region below is
        // what announces this; without it the sentence is read twice.
        <p
          data-testid="provider-pack-discovery-check-notice"
          aria-hidden="true"
          className={cn(
            "text-ui-xs",
            props.checkNotice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {props.checkNotice.message}
        </p>
      ) : null}
      <VersionManagerCheckLiveStatus notice={props.checkNotice} />
    </div>
  );
}

/** Screen-reader-only counterpart to the footer's check notice, which stays `aria-hidden`. `sr-only` is
 * `position: absolute`, so this is not a flex item and adds no gap to the band while it is empty. */
function VersionManagerCheckLiveStatus(props: {
  readonly notice: PackDiscoveryCheckNotice | null;
}): JSX.Element {
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {props.notice?.message ?? null}
    </span>
  );
}

function UpdateAvailableBanner(props: {
  readonly version: string;
  readonly canDownload: boolean;
  readonly disabledReason: string | null;
  readonly notice: BannerNotice | null;
  readonly downloadPending: boolean;
  readonly actionsDisabled: boolean;
  readonly onDownload: (version: string) => void;
}): JSX.Element {
  return (
    // A full-width strip, not the inset rounded card this was.
    <div
      data-testid="provider-pack-update-available-banner"
      className="flex w-full shrink-0 flex-col gap-2 border-b border-border bg-foreground/3 px-4 py-2.5"
    >
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-ui-sm text-foreground">
          New version <span className="font-semibold">{props.version}</span> is
          available.
        </p>
        <Button
          type="button"
          size="xs"
          data-testid="provider-pack-update-download"
          disabled={!props.canDownload || props.actionsDisabled}
          onClick={() => props.onDownload(props.version)}
        >
          Download
          {props.downloadPending ? <MutedAgentSpinner /> : null}
        </Button>
      </div>
      {props.disabledReason !== null ? (
        <p
          data-testid="provider-pack-update-banner-disabled-reason"
          className="text-ui-xs text-muted-foreground"
        >
          {props.disabledReason}
        </p>
      ) : null}
      {props.notice !== null ? (
        <p
          data-testid="provider-pack-update-banner-notice"
          className="text-ui-xs text-destructive"
        >
          {props.notice.message}
        </p>
      ) : null}
    </div>
  );
}

type VersionRowProps = {
  readonly row: ProviderPackVersion;
  readonly notice: RowNotice | null;
  readonly deleteArmed: boolean;
  readonly downloadPending: boolean;
  readonly usePending: boolean;
  readonly deletePending: boolean;
  readonly actionsDisabled: boolean;
  readonly onDownload: (version: string) => void;
  readonly onUse: (version: string) => void;
  readonly onArmDelete: (version: string) => void;
  readonly onDelete: (version: string) => void;
};

/** Size went with it: it decides one question, "what do I delete to reclaim space", and a figure you must hover
 * each row in turn to collect is a poor way to answer it. */
function VersionRow(props: VersionRowProps): JSX.Element {
  const {
    row,
    notice,
    deleteArmed,
    downloadPending,
    usePending,
    deletePending,
    actionsDisabled,
    onDownload,
    onUse,
    onArmDelete,
    onDelete,
  } = props;

  const download = versionDownloadEligibility(row);
  const useElig = versionUseEligibility(row);
  const del = versionDeleteEligibility(row);
  const chip = versionRowChip(row);
  const trouble = versionTroubleLine(row);
  const greyed = isBlockingCertification(row.certification);

  const showFetch = versionShowsInstallFetchAction(row);
  const fetchLabel = versionInstallFetchLabel(row);

  return (
    <li
      data-testid={`provider-pack-version-row-${row.version}`}
      data-version={row.version}
      className={cn(
        // `first:border-t-0` because the list no longer has a header above it to divide from - a top border on row one
        // drew a line directly under the popover's own edge, or under a banner's, doubling it.
        "w-full border-t border-border px-4 py-1.5 first:border-t-0",
        greyed && "opacity-70",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <span className="font-mono text-ui-sm text-foreground">
          {row.version}
        </span>
        {chip === null ? null : <VersionChip chip={chip} />}
        <span className="flex-1" />
        <VersionRowActions
          row={row}
          download={download}
          useElig={useElig}
          del={del}
          showFetch={showFetch}
          fetchLabel={fetchLabel}
          deleteArmed={deleteArmed}
          downloadPending={downloadPending}
          usePending={usePending}
          deletePending={deletePending}
          actionsDisabled={actionsDisabled}
          onDownload={onDownload}
          onUse={onUse}
          onArmDelete={onArmDelete}
          onDelete={onDelete}
        />
      </div>

      {row.installState.status === "downloading" ? (
        <DownloadProgress percent={row.installState.percent} />
      ) : null}

      <VersionRowFootnote notice={notice} trouble={trouble} />
    </li>
  );
}

/** At most one line under a row, and the action notice wins. */
function VersionRowFootnote(props: {
  readonly notice: RowNotice | null;
  readonly trouble: string | null;
}): JSX.Element | null {
  if (props.notice !== null) {
    return (
      <p
        data-testid="version-row-notice"
        className={cn(
          "mt-1.5 text-ui-xs",
          props.notice.kind === "error"
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {props.notice.message}
      </p>
    );
  }
  if (props.trouble === null) return null;
  return (
    <p
      data-testid="version-row-trouble"
      className="mt-1.5 text-ui-xs text-muted-foreground"
    >
      {props.trouble}
    </p>
  );
}

function VersionChip(props: { readonly chip: VersionRowChip }): JSX.Element {
  const style = chipStyle(props.chip.tone);
  return (
    <Badge
      variant={style.variant}
      className={style.className}
      data-testid={`version-row-chip-${props.chip.tone}`}
    >
      {props.chip.label}
    </Badge>
  );
}

type ChipStyle = {
  readonly variant: "default" | "destructive" | "outline";
  readonly className: string | undefined;
};

/** `outline` is safe by construction because `--border` never collapses. */
function chipStyle(tone: VersionRowChip["tone"]): ChipStyle {
  if (tone === "current") return { variant: "default", className: undefined };
  if (tone === "blocked") {
    return { variant: "destructive", className: undefined };
  }
  if (tone === "unpublished") {
    return { variant: "outline", className: "text-muted-foreground" };
  }
  return { variant: "outline", className: undefined };
}

function VersionRowActions(props: {
  readonly row: ProviderPackVersion;
  readonly download: VersionDownloadEligibility;
  readonly useElig: VersionUseEligibility;
  readonly del: VersionDeleteEligibility;
  readonly showFetch: boolean;
  readonly fetchLabel: "Download" | "Retry";
  readonly deleteArmed: boolean;
  readonly downloadPending: boolean;
  readonly usePending: boolean;
  readonly deletePending: boolean;
  readonly actionsDisabled: boolean;
  readonly onDownload: (version: string) => void;
  readonly onUse: (version: string) => void;
  readonly onArmDelete: (version: string) => void;
  readonly onDelete: (version: string) => void;
}): JSX.Element {
  const {
    row,
    download,
    useElig,
    del,
    showFetch,
    fetchLabel,
    deleteArmed,
    downloadPending,
    usePending,
    deletePending,
    actionsDisabled,
    onDownload,
    onUse,
    onArmDelete,
    onDelete,
  } = props;

  const downloading = row.installState.status === "downloading";
  const showUse = row.installState.status === "installed" && !row.current;
  const showDelete = versionShowsDeleteAction(row);
  const fetchDisabled = actionsDisabled || !download.allowed;
  const useDisabled = actionsDisabled || !useElig.allowed;
  const fetchTooltip = download.allowed ? null : download.reason;
  const useTooltip = useElig.allowed ? null : useElig.reason;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {downloading ? (
        // The button carries only "something is happening"; the progress bar
        // below the row carries how far along. A word here duplicated the bar.
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          disabled
          aria-label={`Downloading ${row.version}`}
        >
          <MutedAgentSpinner />
        </Button>
      ) : null}

      {showFetch ? (
        <ActionButton
          label={fetchLabel}
          version={row.version}
          icon={fetchLabel === "Retry" ? RotateCw : Download}
          disabled={fetchDisabled}
          tooltip={fetchTooltip}
          pending={downloadPending}
          onClick={() => onDownload(row.version)}
        />
      ) : null}

      {showUse ? (
        <ActionButton
          label="Use"
          version={row.version}
          icon={Check}
          disabled={useDisabled}
          tooltip={useTooltip}
          pending={usePending}
          onClick={() => onUse(row.version)}
        />
      ) : null}

      {showDelete ? (
        <DeleteAction
          version={row.version}
          armed={deleteArmed}
          eligibility={del}
          pending={deletePending}
          actionsDisabled={actionsDisabled}
          onArm={onArmDelete}
          onConfirm={onDelete}
        />
      ) : null}
    </div>
  );
}

/** The component no longer decides which blocks exist; asking the model is what keeps a new block from silently
 * rendering no control at all. */
function DeleteAction(props: {
  readonly version: string;
  readonly armed: boolean;
  readonly eligibility: VersionDeleteEligibility;
  readonly pending: boolean;
  readonly actionsDisabled: boolean;
  readonly onArm: (version: string) => void;
  readonly onConfirm: (version: string) => void;
}): JSX.Element {
  if (props.armed && props.eligibility.allowed) {
    return (
      <ArmedDeleteButton
        version={props.version}
        pending={props.pending}
        disabled={props.actionsDisabled}
        onConfirm={props.onConfirm}
      />
    );
  }

  return (
    <ActionButton
      label="Delete"
      version={props.version}
      icon={Trash2}
      destructive
      disabled={props.actionsDisabled || !props.eligibility.allowed}
      tooltip={props.eligibility.allowed ? null : props.eligibility.reason}
      pending={props.pending}
      testId={props.eligibility.allowed ? undefined : "delete-disabled-blocked"}
      onClick={() => props.onArm(props.version)}
    />
  );
}

/** Whatever the pointer does, that drops a keyboard user's focus to `<body>`, so the second press of a
 * two-press flow has nothing to land on and the state change is never announced. */
function ArmedDeleteButton(props: {
  readonly version: string;
  readonly pending: boolean;
  readonly disabled: boolean;
  readonly onConfirm: (version: string) => void;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  return (
    <Button
      ref={confirmRef}
      type="button"
      size="xs"
      variant="destructive"
      data-testid={`version-delete-confirm-${props.version}`}
      disabled={props.disabled}
      aria-label={`Confirm delete ${props.version}`}
      onClick={() => props.onConfirm(props.version)}
    >
      Delete?
      {props.pending ? <MutedAgentSpinner /> : null}
    </Button>
  );
}

/** One icon-only row control. */
function ActionButton(props: {
  readonly label: string;
  readonly version: string;
  readonly icon: LucideIcon;
  readonly disabled: boolean;
  readonly tooltip: string | null;
  readonly pending: boolean;
  readonly destructive?: boolean;
  readonly testId?: string;
  readonly onClick: () => void;
}): JSX.Element {
  const Icon = props.icon;
  const accessibleName = `${props.label} ${props.version}`;

  const button = (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn(
        props.destructive === true &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive",
      )}
      disabled={props.disabled}
      data-testid={props.testId}
      aria-label={accessibleName}
      onClick={props.onClick}
    >
      {props.pending ? <MutedAgentSpinner /> : <Icon aria-hidden="true" />}
    </Button>
  );

  return (
    <TooltipWrapper
      label={props.tooltip ?? accessibleName}
      side="top"
      sideOffset={4}
      align="center"
    >
      {/* The span is load-bearing on the disabled path: `disabled` buttons emit no pointer events, so a tooltip bound
         to the button itself never opens for exactly the states whose reason the user most needs. */}
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

function DownloadProgress(props: {
  readonly percent: number | null;
}): JSX.Element {
  // percent null = sibling host owns the transfer - indeterminate, not error.
  if (props.percent === null) {
    return (
      <div
        data-testid="download-progress-indeterminate"
        className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-foreground/8"
        role="progressbar"
        aria-valuetext="Download in progress on another host"
        aria-busy="true"
      >
        <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
      </div>
    );
  }
  const clamped = Math.min(100, Math.max(0, Math.round(props.percent)));
  return (
    <div
      data-testid="download-progress-determinate"
      className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-foreground/8"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={clamped}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
        style={{ width: `${String(clamped)}%` }}
      />
    </div>
  );
}
