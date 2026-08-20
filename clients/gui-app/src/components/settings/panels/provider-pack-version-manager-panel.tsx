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
import { useProvidersInstallPackVersion } from "@/hooks/providers/use-providers-install-pack-version-mutation";
import { useProvidersRemovePackVersion } from "@/hooks/providers/use-providers-remove-pack-version-mutation";
import { useProvidersSetPackPolicy } from "@/hooks/providers/use-providers-set-pack-policy-mutation";
import { useProvidersUsePackVersion } from "@/hooks/providers/use-providers-use-pack-version-mutation";
import { cn } from "@/lib/utils";
import {
  comparePackVersionsDescending,
  formatSharedWithProvidersLine,
  installPackVersionRefusalMessage,
  isBlockingCertification,
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
 * v7.0 (`packId` + `managedVersions`) plus the **settings-scoped** `hostId`
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
 * The row whose Delete is armed — identified by WHERE it is, not just which
 * version, so the arming cannot outlive the host and pack it was made on.
 */
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

/**
 * Per-pack version manager panel (B5-T2).
 *
 * Three regions, in the order a reader needs them: what is true of the pack
 * right now (sharing, a pin, an available update), the versions themselves,
 * and one persistent setting pinned to the bottom.
 *
 * The panel used to open with a titled header bar — `<pack> CLI · versions`,
 * a footprint line, and the auto-download switch. All three were dropped:
 *
 * - The TITLE restated the row the popover is anchored to. It is opened from
 *   one specific CLI's version cell, so naming that CLI again is the widest,
 *   loudest element on the surface saying the one thing the user cannot have
 *   forgotten. `aria-label` on the section keeps it for screen readers, which
 *   do NOT get the anchoring for free.
 * - The FOOTPRINT was `managedVersions.totalSizeBytes` — the whole pack cell
 *   across every retained version — sitting directly above rows whose own
 *   sizes are per-version. Two numbers on different axes, one labelled "on
 *   disk" and neither summing to the other, read as an error in the smaller
 *   one. The per-version sizes stayed (they answer "what will this cost me");
 *   the total left, because a pack-wide figure belongs wherever pack-wide
 *   storage is managed, not in a version picker.
 * - The SWITCH moved to the footer. It is a durable preference, not an action
 *   on any version, so it wants the calmest position on the surface rather
 *   than the most prominent — and out of the header it stops competing with
 *   the pin banner for the same corner.
 *
 * Mutations go through the four v7.0 pack RPCs.
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
  // The version whose Delete is ARMED — its icon has been clicked once and is
  // now showing a labelled "Delete?" awaiting the second click.
  //
  // Delete used to be a word-labelled button that fired on its only click. It
  // is now a 28px unlabelled trash icon sitting one gap away from the other
  // row actions, which makes a mis-click both likelier and less obviously a
  // mistake while it is happening. Re-downloading is usually the whole cost of
  // one, but not always: an `uncertified` version is still installed, still
  // usable, and NOT re-downloadable, so for that row a slip is irreversible.
  //
  // Deliberately not a timeout — a self-disarming control is untestable
  // without fake timers and, worse, can disarm between a user deciding and
  // clicking. It disarms on any other action in the panel (via `clearNotice`)
  // and on unmount, which closing the popover does.
  //
  // Keyed by host and pack as well as version, because this panel is mounted
  // unkeyed under a settings scope whose host can AUTO-FOLLOW to another
  // machine while the popover is open. A bare version string would survive
  // that move, and if the new host also carries `1.5.0` its row would mount
  // already armed — one press from deleting something on a machine the user
  // never armed anything on. Matching the full key makes the move disarm for
  // free, with no effect and no remount.
  const [armedDelete, setArmedDelete] = useState<ArmedDelete | null>(null);
  const armedVersion = armedVersionWithin(armedDelete, hostId, packId);

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
    setArmedDelete(null);
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
      //
      // NO frame of its own. This panel only ever mounts inside
      // `VersionMenuTrigger`'s `PopoverContent`, which already draws the
      // surface: `rounded-lg bg-popover ring-1 shadow-md`, with `p-0` and
      // `overflow-hidden` so a full-bleed child clips to its corners. The
      // `rounded-xl border border-border bg-card` this used to add put a
      // SECOND 1px line inside the ring at a LARGER radius than the container
      // it sat in, so the popover's own corners showed through as four slivers
      // behind the card's — the frayed edge in the report. `bg-card` over
      // `bg-popover` was a second, quieter mismatch of the same kind.
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

      {/*
        Capped so the list SHOWS about four rows and scrolls the rest, instead
        of growing to whatever the popover's own `max-h` allows. Two reasons
        the outer cap was not enough: `managedVersions.available` is every
        published version plus every retained install, so on a mature pack the
        popover simply became a full-height wall of near-identical rows; and
        the footer only reads as a footer when the list visibly ends above it.
        Viewport-derived, per the repo's fluid-sizing rule. A row is ~41px
        (`py-1.5` around a 28px icon button, plus its 1px rule), so 10.5rem
        lands PART-WAY THROUGH the fifth: four rows read whole and the clipped
        one is the scroll affordance. A cap on a row boundary would look like
        the list simply ends.
      */}
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
        onToggleAutoDownload={onToggleAutoDownload}
      />
    </section>
  );
}

/**
 * What is true of the PACK, above the list of versions.
 *
 * Everything here is conditional, and on the common pack — unshared, unpinned,
 * up to date — the whole region renders nothing and the popover opens directly
 * onto the versions. That is the point of it having replaced a header: a header
 * is chrome and is always there, whereas each of these is a fact that is only
 * sometimes worth a line.
 *
 * The sharing line is the one that had to survive the header's removal. It is
 * the only warning that a pack backs several providers, which is what makes a
 * delete here reach further than the CLI the user opened this from.
 */
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

/**
 * The one durable preference on this surface, pinned below the list.
 *
 * Outside the scrolling `<ul>` rather than `position: sticky` inside it: the
 * list is a sibling that scrolls its own overflow, so this row is always
 * visible by construction and never overlaps a row it is scrolling past.
 */
function VersionManagerFooter(props: {
  readonly autoDownload: boolean;
  readonly policyPending: boolean;
  readonly onToggleAutoDownload: (next: boolean) => void;
}): JSX.Element {
  return (
    <label className="flex w-full shrink-0 cursor-pointer items-center justify-between gap-3 border-t border-border bg-foreground/5 px-4 py-2.5 text-ui-xs text-muted-foreground">
      <span>Auto-download updates</span>
      <span className="flex shrink-0 items-center gap-2">
        {props.policyPending ? <MutedAgentSpinner /> : null}
        <Switch
          checked={props.autoDownload}
          onCheckedChange={props.onToggleAutoDownload}
          disabled={props.policyPending}
          aria-label="Auto-download updates"
        />
      </span>
    </label>
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
    // A full-width strip, not the inset rounded card this was. Floating a
    // second bordered box inside a bordered popover, inset from both edges,
    // gave the surface three nested frames before the first version; every
    // other region here is a bordered band, so this one is too.
    //
    // Its Download keeps a WORD while the rows' went to icons. The rows have a
    // repeating action column where labels are redundant by the second row —
    // this is a one-off call to action attached to a sentence, and it is the
    // only control on the surface that acts on a version with no row.
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

/**
 * ONE LINE PER VERSION: the number, at most one chip, one action.
 *
 * This row used to carry the number, up to three badges, a meta line that
 * repeated two of those badges, a condemned sentence that repeated the meta,
 * a `Use disabled: …` line, and up to three buttons. A list whose job is
 * "pick a version" was the hardest thing on the screen to read.
 *
 * That first pass moved the surplus into a hover card on the version number.
 * The card is now gone too, because hiding redundancy is not removing it —
 * three of its five lines restated the row. `Installed` was already told by
 * WHICH action the row offers (`Use` means installed, `Download` means not);
 * `pairs with this Traycer release` is the `Recommended` chip in prose; and
 * `Can't switch to it — …` became a second copy of the disabled `Use` button's
 * own tooltip the moment those buttons went icon-only. Size went with it: it
 * decides one question, "what do I delete to reclaim space", and a figure you
 * must hover each row in turn to collect is a poor way to answer it.
 *
 * Only the certification survived, as a chip, because it is the one thing here
 * that changes whether an ACTION IS REVERSIBLE — see `versionRowChip`.
 *
 * The card also cost more than its content. It made the version number a
 * focusable button with a ring, so a number read as an editable field, and its
 * content opened directly over the rows below it — a list you cannot see while
 * inspecting a member of it.
 *
 * Two things were never in the card and still are not, because a surface you
 * have to go find is the wrong home for them: live download progress, and the
 * notice returned by an action you just took.
 */
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
        // `first:border-t-0` because the list no longer has a header above it
        // to divide from — a top border on row one drew a line directly under
        // the popover's own edge, or under a banner's, doubling it.
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

/**
 * At most ONE line under a row, and the action notice wins.
 *
 * Both answer "what is wrong here", but the notice is the fresher answer — it
 * is the outcome of something the user just did, whereas the trouble line is
 * the standing state they did it FROM. Stacking them shows a refusal directly
 * above the condition that caused it, which reads as two separate problems.
 */
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

/**
 * Tone → Badge styling, loudest first.
 *
 * `recommended` used to be `secondary`, which is a fill this surface cannot
 * carry: `--secondary` is identical to `--popover` in the amoled and
 * traycer-green dark presets, so the chip was invisible on exactly the themes
 * that collapse it — the same class of defect as the repo's `bg-muted` rule,
 * one token over, and one the `bg-muted` lint cannot see. `outline` is safe by
 * construction because `--border` never collapses.
 *
 * `unpublished` is the same outline with the text dimmed. That is deliberate:
 * a chip warning you that deleting is permanent should be READABLE, not
 * ALARMING — alarm belongs to `blocked`, which is a refusal.
 */
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

/**
 * Delete, in its two shapes.
 *
 * Disabled it stays an icon and explains itself through the tooltip, from
 * `versionDeleteEligibility` — one reason string, whether the block is "this is
 * the version you are running" or "quarantine is holding these bytes". The
 * component no longer decides which blocks exist; asking the model is what
 * keeps a new block from silently rendering no control at all.
 *
 * Armed it becomes a word, which is the whole mechanism: nothing about a second
 * click on an unchanged icon tells the user their first click registered as a
 * request rather than as the deletion.
 */
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

/**
 * The armed half of the two-step delete, split out for the focus effect.
 *
 * Arming REPLACES a DOM node rather than restyling one: the trash
 * `ActionButton` (tooltip → span → button) unmounts and this button mounts in
 * its place. Whatever the pointer does, that drops a keyboard user's focus to
 * `<body>`, so the second press of a two-press flow has nothing to land on and
 * the state change is never announced — the confirmation step becomes a
 * mouse-only affordance. Focusing on mount is what keeps the two presses on one
 * control, and it is imperative because `jsx-a11y` forbids the `autoFocus` prop.
 *
 * The visible word can't carry the version the way the icon buttons' labels do
 * ("Delete?" has to stay short), so the accessible name restates it: in a
 * five-row list an unqualified "Delete?" names no version at all.
 */
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

/**
 * One icon-only row control.
 *
 * `label` does triple duty — the accessible name (with the version appended, so
 * the buttons of a five-row list are distinguishable), the tooltip when the
 * control is live, and the thing a refusal replaces when it is not. A tooltip
 * is therefore ALWAYS rendered: an icon button with nothing to hover is a
 * guessing game, which is the standing cost of dropping the words and the
 * reason this component has no "no tooltip" path.
 */
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
      {/*
        The span is load-bearing on the disabled path: `disabled` buttons emit
        no pointer events, so a tooltip bound to the button itself never opens
        for exactly the states whose reason the user most needs.
      */}
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
