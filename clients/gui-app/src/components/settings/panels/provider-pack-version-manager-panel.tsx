import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type {
  ProviderManagedVersions,
  ProviderPackVersion,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useProviderPackVersionManagerSupport } from "./provider-pack-version-manager-capability";
import {
  createVersionManagerPanelToken,
  registerVersionManagerPanel,
} from "./provider-pack-version-manager-presence";
import { useProvidersInstallPackVersion } from "@/hooks/providers/use-providers-install-pack-version-mutation";
import { useProvidersRemovePackVersion } from "@/hooks/providers/use-providers-remove-pack-version-mutation";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { cn } from "@/lib/utils";
import {
  comparePackVersionsDescending,
  formatPackSizeBytes,
  formatSharedWithProvidersLine,
  installPackVersionRefusalMessage,
  isBlockingCertification,
  removeResultUserMessage,
  updateBannerDownloadEligibility,
  packVersionUseRefusalMessage,
  versionDeleteEligibility,
  versionDetailLines,
  versionDownloadEligibility,
  versionInstallFetchLabel,
  versionRowChip,
  versionShowsInstallFetchAction,
  versionUseEligibility,
  type VersionDeleteEligibility,
  type VersionDownloadEligibility,
  type VersionRowChip,
  type VersionUseEligibility,
} from "./provider-pack-version-manager-model";

/** Pending key for "Use latest automatically" (clear pin / version: null). */
const CLEAR_PIN_PENDING_KEY = "__auto__";

/**
 * Public props for the per-pack version manager. The CLI candidates table
 * ticket mounts this panel and supplies the wire fields from `providers.list`
 * v8.0 (`packId` + `managedVersions`) plus the **settings-scoped** `hostId`
 * already threaded through this tree (`scope.hostId`). Do not ambiently
 * re-read the globally active host — the settings surface can display one
 * host while another is active.
 *
 * Capability: gated on every member of
 * {@link PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS} via
 * {@link useProviderPackVersionManagerSupport} (three-valued) against the
 * **passed** `hostId`.
 * - `hostId === null` or support `null` → pending (not unsupported).
 * - support `false` → clear "host too old" (no action buttons).
 * - support `true` → full panel.
 */
export type ProviderPackVersionManagerPanelProps = {
  /**
   * Settings-scoped host this panel is about. Same source as every other
   * child under `providers-settings-panel` (`scope.hostId`). Null when the
   * scope has no host yet — treated like capability-unknown (pending), never
   * as "unsupported".
   */
  readonly hostId: string | null;
  /** Machine-shared pack id (e.g. `opencode`). Keys every mutation. */
  readonly packId: string;
  /**
   * Short pack title for the header, e.g. `"opencode CLI"`. Not a provider
   * id — shared packs have one name that is not any single provider.
   */
  readonly packDisplayName: string;
  /** Per-pack manager state from the provider row. */
  readonly managedVersions: ProviderManagedVersions;
};

type RowNotice = {
  readonly version: string;
  readonly kind: "info" | "error";
  readonly message: string;
};

/** Banner-scoped notice when the durable update version has no row to attach. */
type BannerNotice = {
  readonly kind: "error";
  readonly message: string;
};

/**
 * Per-pack version manager panel (B5-T2).
 *
 * Renders the wireframe surface: header (name, sharing, footprint, auto-
 * download toggle), update-available banner, and one action row per version.
 * Mutations go through the four v8.0 pack RPCs.
 *
 * Capability-gated (non-floor optional RPCs): see
 * {@link PROVIDER_PACK_VERSION_MANAGER_CAPABILITY_METHODS}.
 */
export function ProviderPackVersionManagerPanel(
  props: ProviderPackVersionManagerPanelProps,
): JSX.Element {
  const { hostId, packId, packDisplayName, managedVersions } = props;
  // Gate against the settings-scoped host only. The hook already returns null
  // when hostId is null (no handshake possible yet).
  const methodSupport = useProviderPackVersionManagerSupport(hostId);

  // This panel's own identity, handed to every mutation it starts so the
  // outcome comes back to THIS panel rather than to whichever panel happens to
  // be mounted when the response lands. Re-minted when the pack changes: an
  // RPC still in flight for the old pack then holds a token this panel no
  // longer registers, and the hook toasts it instead of trusting a panel that
  // has no row for it. A recomputation for any other reason degrades the same
  // way - toward a toast, never toward silence.
  const panelToken = useMemo(
    () => createVersionManagerPanelToken(packId),
    [packId],
  );

  const install = useProvidersInstallPackVersion(panelToken);
  const remove = useProvidersRemovePackVersion(panelToken);
  const useVersion = useProvidersUsePackVersion(panelToken);
  const setPolicy = useProvidersSetPackPolicy();

  const [rowNotice, setRowNotice] = useState<RowNotice | null>(null);
  const [bannerNotice, setBannerNotice] = useState<BannerNotice | null>(null);
  // Pin-scoped, and NOT the update banner. `bannerNotice` renders only inside
  // `UpdateAvailableBanner`, which only mounts when `updateAvailable !== null`
  // - so routing a clear-pin refusal there still dropped it whenever no update
  // was pending, which is most of the time. The pinned banner below renders on
  // exactly the condition that makes a clear-pin refusal possible.
  const [pinNotice, setPinNotice] = useState<BannerNotice | null>(null);
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);

  // Tell the mutation hooks this panel is on screen to render outcomes. While
  // it is, refusals draw inline below, anchored to what they are about; once
  // the popover closes this unregisters and the hooks toast instead. Without
  // it, an outcome that lands after close is either dropped or double-drawn.
  //
  // Registered only for the render that actually HAS those inline surfaces.
  // The pending and unsupported branches below return early, before any notice
  // is drawn, so a registration there would claim an outcome it cannot show.
  const canRenderOutcome = hostId !== null && methodSupport === true;
  useEffect(() => {
    if (!canRenderOutcome) return undefined;
    return registerVersionManagerPanel(panelToken);
  }, [canRenderOutcome, panelToken]);

  const sharedLine = formatSharedWithProvidersLine(
    managedVersions.sharedWithProviders,
  );
  const totalSizeLabel = formatPackSizeBytes(managedVersions.totalSizeBytes);
  const updateAvailable = managedVersions.updateAvailable;
  const bannerDownload =
    updateAvailable === null
      ? null
      : updateBannerDownloadEligibility(
          managedVersions.available,
          updateAvailable.version,
        );

  const clearNotice = useCallback(() => {
    setRowNotice(null);
    setBannerNotice(null);
    setPinNotice(null);
  }, []);

  const onToggleAutoDownload = useCallback(
    (next: boolean) => {
      clearNotice();
      setPolicy.mutate({ packId, autoDownload: next });
    },
    [clearNotice, packId, setPolicy],
  );

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
                // Durable banner may name a version with no row — surface on
                // the banner, not a phantom row notice.
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
          // The PIN banner. Not a row notice: those render inside `VersionRow`
          // keyed by version, and the pinned version has no row exactly when a
          // user is most likely to be clearing the pin (a pin on a build the
          // channel no longer lists). Not the update banner either: that one
          // only mounts when an update is pending.
          setPinNotice({
            kind: "error",
            message: packVersionUseRefusalMessage(response.result.code),
          });
        },
      },
    );
  }, [clearNotice, packId, useVersion]);

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
        className="flex w-full max-w-2xl items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-ui-sm text-muted-foreground"
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
        className="w-full max-w-2xl rounded-xl border border-border bg-card px-4 py-3 text-ui-sm text-muted-foreground sm:px-5"
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

  const anyPending =
    install.isPending ||
    remove.isPending ||
    useVersion.isPending ||
    setPolicy.isPending;

  return (
    <section
      data-testid="provider-pack-version-manager"
      data-pack-id={packId}
      data-host-id={hostId}
      // `min-h-0` so the list below can actually scroll inside a height-capped
      // container instead of forcing this section past it.
      className="flex w-full min-h-0 max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-card"
      aria-label={`${packDisplayName} versions`}
    >
      <VersionManagerHeader
        packDisplayName={packDisplayName}
        sharedLine={sharedLine}
        totalSizeLabel={totalSizeLabel}
        autoDownload={managedVersions.autoDownload}
        pinnedVersion={managedVersions.pinnedVersion}
        pinNotice={pinNotice}
        clearPinPending={
          pendingVersion === CLEAR_PIN_PENDING_KEY && useVersion.isPending
        }
        policyPending={setPolicy.isPending}
        actionsDisabled={anyPending}
        onToggleAutoDownload={onToggleAutoDownload}
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

      <ul className="flex w-full min-h-0 flex-col overflow-y-auto">
        {rows.map((row) => (
          <VersionRow
            key={row.version}
            row={row}
            notice={
              rowNotice !== null && rowNotice.version === row.version
                ? rowNotice
                : null
            }
            downloadPending={
              pendingVersion === row.version && install.isPending
            }
            usePending={pendingVersion === row.version && useVersion.isPending}
            deletePending={pendingVersion === row.version && remove.isPending}
            actionsDisabled={anyPending}
            onDownload={onDownload}
            onUse={onUse}
            onDelete={onDelete}
          />
        ))}
        {rows.length === 0 ? (
          <li className="px-4 py-6 text-center text-ui-sm text-muted-foreground sm:px-5">
            No versions listed for this pack yet.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function formatFootprintLine(
  sharedLine: string | null,
  totalSizeLabel: string | null,
): string | null {
  if (sharedLine !== null && totalSizeLabel !== null) {
    return `${sharedLine} · ${totalSizeLabel} on disk`;
  }
  if (sharedLine !== null) return sharedLine;
  if (totalSizeLabel !== null) return `${totalSizeLabel} on disk`;
  return null;
}

function VersionManagerHeader(props: {
  readonly packDisplayName: string;
  readonly sharedLine: string | null;
  readonly totalSizeLabel: string | null;
  readonly autoDownload: boolean;
  readonly pinnedVersion: string | null;
  readonly pinNotice: BannerNotice | null;
  readonly clearPinPending: boolean;
  readonly policyPending: boolean;
  readonly actionsDisabled: boolean;
  readonly onToggleAutoDownload: (next: boolean) => void;
  readonly onClearPin: () => void;
}): JSX.Element {
  const footprint = formatFootprintLine(props.sharedLine, props.totalSizeLabel);

  return (
    <header className="flex w-full flex-col gap-3 border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-ui-sm font-semibold text-foreground">
            {props.packDisplayName}
            <span className="font-normal text-muted-foreground">
              {" "}
              · versions
            </span>
          </h3>
          {footprint !== null ? (
            <p className="mt-1 text-ui-xs text-muted-foreground">{footprint}</p>
          ) : null}
        </div>
        <label className="flex shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
          <span>Auto-download updates</span>
          <Switch
            checked={props.autoDownload}
            onCheckedChange={props.onToggleAutoDownload}
            disabled={props.policyPending}
            aria-label="Auto-download updates"
          />
          {props.policyPending ? <MutedAgentSpinner /> : null}
        </label>
      </div>
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
            size="sm"
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
    </header>
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
    <div
      data-testid="provider-pack-update-available-banner"
      className="mx-4 mt-3 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5 sm:mx-5"
    >
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-ui-sm text-foreground">
          New version <span className="font-semibold">{props.version}</span> is
          available.
        </p>
        <Button
          type="button"
          size="sm"
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
  readonly downloadPending: boolean;
  readonly usePending: boolean;
  readonly deletePending: boolean;
  readonly actionsDisabled: boolean;
  readonly onDownload: (version: string) => void;
  readonly onUse: (version: string) => void;
  readonly onDelete: (version: string) => void;
};

/**
 * ONE LINE PER VERSION: the number, at most one chip, one action.
 *
 * This row used to carry the number, up to three badges, a meta line that
 * repeated two of those badges, a condemned sentence that repeated the meta,
 * a `Use disabled: …` line, and up to three buttons. A list whose job is
 * "pick a version" was the hardest thing on the screen to read.
 *
 * What stayed inline is what a list cannot delegate: the number you scan, the
 * one state worth scanning FOR, and the control. What moved to the hover card
 * is everything you only want once you have already picked a row.
 *
 * Two things deliberately did NOT move to the card, because a card you have
 * to go find is the wrong home for them: live download progress, and the
 * notice returned by an action you just took.
 */
function VersionRow(props: VersionRowProps): JSX.Element {
  const {
    row,
    notice,
    downloadPending,
    usePending,
    deletePending,
    actionsDisabled,
    onDownload,
    onUse,
    onDelete,
  } = props;

  const download = versionDownloadEligibility(row);
  const useElig = versionUseEligibility(row);
  const del = versionDeleteEligibility(row);
  const chip = versionRowChip(row);
  const detailLines = versionDetailLines(row);
  const greyed = isBlockingCertification(row.certification);

  const showFetch = versionShowsInstallFetchAction(row);
  const fetchLabel = versionInstallFetchLabel(row);

  return (
    <li
      data-testid={`provider-pack-version-row-${row.version}`}
      data-version={row.version}
      className={cn(
        "w-full border-t border-border px-4 py-2.5 sm:px-5",
        greyed && "opacity-70",
      )}
    >
      <div className="flex w-full items-center gap-2">
        <VersionDetailsHoverCard version={row.version} lines={detailLines}>
          <span className="font-mono text-ui-sm text-foreground">
            {row.version}
          </span>
        </VersionDetailsHoverCard>
        {chip === null ? null : (
          <Badge
            variant={chipVariant(chip.tone)}
            data-testid={`version-row-chip-${chip.tone}`}
          >
            {chip.label}
          </Badge>
        )}
        <span className="flex-1" />
        <VersionRowActions
          row={row}
          download={download}
          useElig={useElig}
          del={del}
          showFetch={showFetch}
          fetchLabel={fetchLabel}
          downloadPending={downloadPending}
          usePending={usePending}
          deletePending={deletePending}
          actionsDisabled={actionsDisabled}
          onDownload={onDownload}
          onUse={onUse}
          onDelete={onDelete}
        />
      </div>

      {row.installState.status === "downloading" ? (
        <DownloadProgress percent={row.installState.percent} />
      ) : null}

      {notice !== null ? (
        <p
          data-testid="version-row-notice"
          className={cn(
            "mt-1.5 text-ui-xs",
            notice.kind === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {notice.message}
        </p>
      ) : null}
    </li>
  );
}

function chipVariant(
  tone: VersionRowChip["tone"],
): "default" | "destructive" | "secondary" {
  if (tone === "current") return "default";
  if (tone === "blocked") return "destructive";
  return "secondary";
}

/**
 * The version's details, on hover or focus of its number.
 *
 * READ-ONLY BY CONTRACT. `hover-card.tsx` documents that Radix keeps card
 * content out of the sequential tab order, so anything actionable placed here
 * would be unreachable by keyboard - which is why every control stayed in the
 * row and only sentences came here.
 *
 * The same sentences are also the trigger's accessible name: a HoverCard
 * mounts no visually-hidden a11y clone the way a Tooltip does, so without this
 * a screen reader would get the bare version number and none of its state.
 */
function VersionDetailsHoverCard(props: {
  readonly version: string;
  readonly lines: readonly string[];
  readonly children: JSX.Element;
}): JSX.Element {
  if (props.lines.length === 0) return props.children;
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <button
          type="button"
          data-testid={`version-details-trigger-${props.version}`}
          aria-label={`${props.version} — ${props.lines.join(". ")}`}
          className="cursor-default rounded-sm decoration-dotted underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {props.children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        // `max-w-*` rather than a fixed `w-*`: a row whose only detail is
        // "Not installed" gets a card that size, and the repo forbids fixed
        // widths for layout surfaces anyway.
        className="max-w-xs p-3"
        data-testid={`version-details-${props.version}`}
      >
        <p className="font-mono text-ui-sm text-foreground">{props.version}</p>
        {props.lines.map((line) => (
          <p key={line} className="mt-1 text-ui-xs text-muted-foreground">
            {line}
          </p>
        ))}
      </HoverCardContent>
    </HoverCard>
  );
}

function VersionRowActions(props: {
  readonly row: ProviderPackVersion;
  readonly download: VersionDownloadEligibility;
  readonly useElig: VersionUseEligibility;
  readonly del: VersionDeleteEligibility;
  readonly showFetch: boolean;
  readonly fetchLabel: "Download" | "Retry";
  readonly downloadPending: boolean;
  readonly usePending: boolean;
  readonly deletePending: boolean;
  readonly actionsDisabled: boolean;
  readonly onDownload: (version: string) => void;
  readonly onUse: (version: string) => void;
  readonly onDelete: (version: string) => void;
}): JSX.Element {
  const {
    row,
    download,
    useElig,
    del,
    showFetch,
    fetchLabel,
    downloadPending,
    usePending,
    deletePending,
    actionsDisabled,
    onDownload,
    onUse,
    onDelete,
  } = props;

  const downloading = row.installState.status === "downloading";
  const showUse = row.installState.status === "installed" && !row.current;
  const fetchDisabled = actionsDisabled || !download.allowed;
  const useDisabled = actionsDisabled || !useElig.allowed;
  const fetchTooltip = download.allowed ? null : download.reason;
  const useTooltip = useElig.allowed ? null : useElig.reason;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {downloading ? (
        <Button type="button" size="sm" variant="outline" disabled>
          Downloading…
          <MutedAgentSpinner />
        </Button>
      ) : null}

      {showFetch ? (
        <ActionButton
          label={fetchLabel}
          disabled={fetchDisabled}
          tooltip={fetchTooltip}
          pending={downloadPending}
          variant={fetchLabel === "Retry" ? "outline" : "default"}
          onClick={() => onDownload(row.version)}
        />
      ) : null}

      {showUse ? (
        <ActionButton
          label="Use"
          disabled={useDisabled}
          tooltip={useTooltip}
          pending={usePending}
          variant="outline"
          onClick={() => onUse(row.version)}
        />
      ) : null}

      {del.allowed ? (
        <ActionButton
          label="Delete"
          disabled={actionsDisabled}
          tooltip={null}
          pending={deletePending}
          variant="outline"
          destructive
          onClick={() => onDelete(row.version)}
        />
      ) : null}

      {row.current ? (
        <ActionButton
          label="Delete"
          disabled
          tooltip="Switch to another version first"
          pending={false}
          variant="outline"
          testId="delete-disabled-current"
          onClick={() => undefined}
        />
      ) : null}
    </div>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly tooltip: string | null;
  readonly pending: boolean;
  readonly variant: "default" | "outline";
  readonly destructive?: boolean;
  readonly testId?: string;
  readonly onClick: () => void;
}): JSX.Element {
  const button = (
    <Button
      type="button"
      size="sm"
      variant={props.variant}
      className={
        props.destructive === true
          ? "text-destructive hover:text-destructive"
          : undefined
      }
      disabled={props.disabled}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      {props.label}
      {props.pending ? <MutedAgentSpinner /> : null}
    </Button>
  );

  if (props.tooltip === null) return button;

  return (
    <TooltipWrapper
      label={props.tooltip}
      side="top"
      sideOffset={4}
      align="center"
    >
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

function DownloadProgress(props: {
  readonly percent: number | null;
}): JSX.Element {
  // percent null = sibling host owns the transfer — indeterminate, not error.
  if (props.percent === null) {
    return (
      <div
        data-testid="download-progress-indeterminate"
        className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted"
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
      className="mt-2 h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted"
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
