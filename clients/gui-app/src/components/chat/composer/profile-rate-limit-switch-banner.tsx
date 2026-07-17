import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { AlertTriangle, ChevronDown, X } from "lucide-react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { HarnessIcon } from "@/components/home/pickers/harness-icon";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  profileAuthStatusText,
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import { ProfileUsageCompactMeter } from "@/components/providers/profile-usage-compact-meter";
import { ProfileUsageSidecar } from "@/components/providers/profile-usage-sidecar";
import { isProfileUsageSidecarTarget } from "@/components/providers/profile-usage-sidecar-target";
import {
  profileUsageAccessibleStatus,
  type ProfileDropdownUsageEntry,
  type ProfileDropdownUsagePresentation,
} from "@/components/providers/profile-dropdown-usage";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useProfileUsagePresentation } from "@/hooks/rate-limits/use-profile-usage-presentation";
import { cn } from "@/lib/utils";
import type {
  ProfileRateLimitDestination,
  ProfileRateLimitSeverity,
} from "./use-profile-rate-limit-switch-prompt";

interface ProfileRateLimitSwitchBannerProps {
  readonly harnessId: GuiHarnessId;
  readonly providerId: ProviderId;
  readonly severity: ProfileRateLimitSeverity;
  readonly current: ProviderProfile;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  readonly primaryTarget: ProfileRateLimitDestination | null;
  readonly runTargetHostId: string | null;
  /** User-confirmed only. Commits the picked profile for the next turn. */
  readonly onSwitchProfile: (profileId: string | null) => void;
  /** Includes the current chat. The current composer commit is handled by
   * `onSwitchProfile`; this callback switches only matching siblings. */
  readonly affectedChatCount: number;
  readonly onSwitchProfileForTask: (profileId: string | null) => void;
  readonly onDismiss: () => void;
}

interface ProfileRateLimitDestinationMenuProps {
  readonly harnessId: GuiHarnessId;
  readonly providerId: ProviderId;
  readonly current: ProviderProfile;
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly destinations: ReadonlyArray<ProfileRateLimitDestination>;
  readonly primaryTarget: ProfileRateLimitDestination | null;
  readonly runTargetHostId: string | null;
  readonly onSwitchProfile: (profileId: string | null) => void;
}

interface ProfileMenuRow {
  readonly profile: ProviderProfile;
  readonly destination: ProfileRateLimitDestination | null;
  readonly selectable: boolean;
  readonly isPrimaryTarget: boolean;
}

const MENU_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Enter",
  "Escape",
]);
const PREVIEW_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);

function switchLabel(profile: ProviderProfile): string {
  return `Switch to ${profileDisplayLabel(profile)}`;
}

function profileMenuRows(
  profiles: ReadonlyArray<ProviderProfile>,
  destinations: ReadonlyArray<ProfileRateLimitDestination>,
  primaryTarget: ProfileRateLimitDestination | null,
): ReadonlyArray<ProfileMenuRow> {
  if (primaryTarget === null) {
    return profiles.map((profile) => ({
      profile,
      destination: null,
      selectable: false,
      isPrimaryTarget: false,
    }));
  }
  return destinations.map((destination) => ({
    profile: destination.profile,
    destination,
    selectable: destination.selectable,
    isPrimaryTarget:
      destination.profile.profileId === primaryTarget.profile.profileId,
  }));
}

function initialPreviewProfileId(
  primaryTarget: ProfileRateLimitDestination | null,
  current: ProviderProfile,
): string | null {
  return primaryTarget === null
    ? profileCommitId(current)
    : primaryTarget.profileId;
}

function profileMenuStatus(
  profile: ProviderProfile,
  usageEntry: ProfileDropdownUsageEntry | undefined,
): string | null {
  if (profile.auth.status !== "authenticated") {
    return profileAuthStatusText(profile);
  }
  if (profile.rateLimitStatus === "near_limit") return "Running low";
  if (profile.rateLimitStatus === "hard_limit") return "Limited";
  if (usageEntry === undefined) return "Not checked";
  const status = profileUsageAccessibleStatus(usageEntry.projection);
  return status === "Healthy" ? null : status;
}

function profileMenuAccessibleLabel(input: {
  readonly profile: ProviderProfile;
  readonly status: string | null;
  readonly selectable: boolean;
  readonly isPrimaryTarget: boolean;
  readonly readOnly: boolean;
}): string {
  let availability = "Read only";
  if (!input.readOnly) {
    availability = input.selectable
      ? "Available to switch"
      : "Unavailable to switch";
  }
  const mainAction = input.isPrimaryTarget ? ", Main action target" : "";
  return `${profileDisplayLabel(input.profile)}, ${input.status ?? "Usage available"}, ${availability}${mainAction}`;
}

function isRefreshShortcut(event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() !== "r") return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }
  return true;
}

function handleUsageMenuKeyDown(
  event: KeyboardEvent,
  entry: ProfileDropdownUsageEntry | undefined,
  isHostReady: boolean,
): void {
  if (MENU_NAVIGATION_KEYS.has(event.key)) event.stopPropagation();
  if (!isRefreshShortcut(event)) return;
  if (entry === undefined || entry.refreshStatus !== "idle" || !isHostReady) {
    return;
  }
  event.preventDefault();
  void entry.refresh();
}

/**
 * Compact, composer-scoped rate-limit advisory. Target eligibility and scope
 * are derived each render; its only state is the banner checkbox. The keyed
 * composer boundary resets that state whenever the warning condition changes.
 */
export function ProfileRateLimitSwitchBanner(
  props: ProfileRateLimitSwitchBannerProps,
) {
  const [includeOtherChats, setIncludeOtherChats] = useState(false);
  const checkboxId = useId();
  const canIncludeOtherChats = props.affectedChatCount > 1;
  const effectiveTaskScope = canIncludeOtherChats && includeOtherChats;
  const readOnly = props.primaryTarget === null;
  const executeSwitch = (profileId: string | null): void => {
    const destination = props.destinations.find(
      (candidate) => candidate.profileId === profileId && candidate.selectable,
    );
    if (destination === undefined) return;
    props.onSwitchProfile(destination.profileId);
    if (effectiveTaskScope) {
      props.onSwitchProfileForTask(destination.profileId);
    }
  };

  return (
    <section
      aria-label="Rate-limit profile switch"
      className="relative w-full overflow-visible rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-ui-sm"
    >
      <TooltipWrapper label="Dismiss" side="top" sideOffset={6} align="end">
        <button
          type="button"
          aria-label="Dismiss rate-limit suggestion"
          className="absolute right-0 top-0 z-10 grid size-6 -translate-y-1/2 translate-x-1/2 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          onClick={props.onDismiss}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </TooltipWrapper>
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-1.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-foreground/90">
            <ProfileRateLimitIdentity
              harnessId={props.harnessId}
              profile={props.current}
            />
            <span>
              {props.severity === "hard_limit"
                ? "has reached its rate limit."
                : "is running low on usage."}
            </span>
            {readOnly ? (
              <span className="text-muted-foreground">
                No other profile is currently available.
              </span>
            ) : null}
          </div>
          <ProfileRateLimitDestinationMenu
            harnessId={props.harnessId}
            providerId={props.providerId}
            current={props.current}
            profiles={props.profiles}
            destinations={props.destinations}
            primaryTarget={props.primaryTarget}
            runTargetHostId={props.runTargetHostId}
            onSwitchProfile={executeSwitch}
          />
          {canIncludeOtherChats ? (
            <div className="flex min-w-0 items-center gap-2 sm:col-start-2 sm:justify-self-end">
              <Checkbox
                id={checkboxId}
                checked={includeOtherChats}
                onCheckedChange={(checked) =>
                  setIncludeOtherChats(checked === true)
                }
              />
              <label
                htmlFor={checkboxId}
                className="min-w-0 cursor-pointer select-none text-foreground"
              >
                Also switch {props.affectedChatCount - 1} other chat
                {props.affectedChatCount === 2 ? "" : "s"} in this task
              </label>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ProfileRateLimitDestinationMenu(
  props: ProfileRateLimitDestinationMenuProps,
) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(() =>
    initialPreviewProfileId(props.primaryTarget, props.current),
  );
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null);
  const keyboardPreviewEnabledRef = useRef(false);
  const usagePresentation = useProfileUsagePresentation({
    runTargetHostId: props.runTargetHostId,
    providerId: props.providerId,
    profiles: props.profiles,
  });
  const readOnly = props.primaryTarget === null;
  const rows = profileMenuRows(
    props.profiles,
    props.destinations,
    props.primaryTarget,
  );
  const previewRow = rows.find(
    (row) => profileCommitId(row.profile) === previewProfileId,
  );
  const previewProfile = previewRow?.profile ?? null;
  const previewEntry =
    previewRow === undefined
      ? undefined
      : usagePresentation.entries.get(previewProfileId);
  const setOpen = (nextOpen: boolean): void => {
    setMenuOpen(nextOpen);
    keyboardPreviewEnabledRef.current = false;
    setPreviewAnchor(null);
    if (!nextOpen) {
      return;
    }
    setPreviewProfileId(
      initialPreviewProfileId(props.primaryTarget, props.current),
    );
  };
  const preview = (profile: ProviderProfile, anchor: HTMLElement): void => {
    setPreviewProfileId(profileCommitId(profile));
    setPreviewAnchor(anchor);
  };
  const previewFromFocus = (
    profile: ProviderProfile,
    anchor: HTMLElement,
  ): void => {
    if (!keyboardPreviewEnabledRef.current) return;
    preview(profile, anchor);
  };

  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={setOpen}>
      <ProfileRateLimitMenuTrigger
        harnessId={props.harnessId}
        primaryTarget={props.primaryTarget}
        onSwitchProfile={props.onSwitchProfile}
      />
      <ProfileRateLimitMenuContent
        rows={rows}
        readOnly={readOnly}
        previewEntry={previewAnchor === null ? undefined : previewEntry}
        usagePresentation={usagePresentation}
        onPreview={preview}
        onFocusPreview={previewFromFocus}
        onKeyboardNavigation={() => {
          keyboardPreviewEnabledRef.current = true;
        }}
        onSwitchProfile={props.onSwitchProfile}
      />
      {menuOpen &&
      previewAnchor !== null &&
      previewProfile !== null &&
      previewEntry !== undefined ? (
        <ProfileUsageSidecar
          anchor={previewAnchor}
          profile={previewProfile}
          entry={previewEntry}
          isHostReady={usagePresentation.isHostReady}
        />
      ) : null}
    </DropdownMenu>
  );
}

function ProfileRateLimitMenuTrigger({
  harnessId,
  primaryTarget,
  onSwitchProfile,
}: {
  readonly harnessId: GuiHarnessId;
  readonly primaryTarget: ProfileRateLimitDestination | null;
  readonly onSwitchProfile: (profileId: string | null) => void;
}): ReactNode {
  if (primaryTarget === null) {
    return (
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="View profile limits"
          className="w-full min-w-0 sm:w-auto sm:justify-self-end"
        >
          <span className="min-w-0 truncate">View profile limits</span>
        </Button>
      </DropdownMenuTrigger>
    );
  }
  const label = switchLabel(primaryTarget.profile);
  return (
    <ButtonGroup
      aria-label="Profile switch actions"
      className="min-w-0 max-w-full sm:justify-self-end"
    >
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-label={label}
        className="min-w-0 max-w-full flex-1"
        onClick={() => onSwitchProfile(primaryTarget.profileId)}
      >
        <span className="shrink-0">Switch to</span>
        <ProfileRateLimitIdentity
          harnessId={harnessId}
          profile={primaryTarget.profile}
        />
      </Button>
      <DropdownMenuTrigger asChild>
        <TooltipWrapper
          label="More profiles"
          side="top"
          sideOffset={6}
          align="end"
        >
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label="Choose another profile"
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
        </TooltipWrapper>
      </DropdownMenuTrigger>
    </ButtonGroup>
  );
}

function ProfileRateLimitMenuContent({
  rows,
  readOnly,
  previewEntry,
  usagePresentation,
  onPreview,
  onFocusPreview,
  onKeyboardNavigation,
  onSwitchProfile,
}: {
  readonly rows: ReadonlyArray<ProfileMenuRow>;
  readonly readOnly: boolean;
  readonly previewEntry: ProfileDropdownUsageEntry | undefined;
  readonly usagePresentation: ProfileDropdownUsagePresentation;
  readonly onPreview: (profile: ProviderProfile, anchor: HTMLElement) => void;
  readonly onFocusPreview: (
    profile: ProviderProfile,
    anchor: HTMLElement,
  ) => void;
  readonly onKeyboardNavigation: () => void;
  readonly onSwitchProfile: (profileId: string | null) => void;
}): ReactNode {
  return (
    <DropdownMenuContent
      align="end"
      side="top"
      sideOffset={8}
      avoidCollisions={false}
      className="w-[min(90vw,24rem)]"
      onInteractOutside={(event) => {
        if (isProfileUsageSidecarTarget(event.target)) event.preventDefault();
      }}
      onKeyDownCapture={(event) => {
        if (!PREVIEW_NAVIGATION_KEYS.has(event.key)) return;
        onKeyboardNavigation();
        // A single-row menu auto-focuses its only item on open, so Radix's
        // roving focus group wraps back onto the already-active item and
        // never calls `.focus()` again - no second `focus` event ever
        // fires to drive the usual onFocus-triggered preview. Detect that
        // degenerate case here and preview the sole row directly instead
        // of waiting on a focus event that will never come.
        if (rows.length !== 1) return;
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement) {
          onPreview(rows[0].profile, activeElement);
        }
      }}
      onKeyDown={(event) =>
        handleUsageMenuKeyDown(
          event,
          previewEntry,
          usagePresentation.isHostReady,
        )
      }
    >
      <DropdownMenuLabel>
        {readOnly ? "Profile limits" : "Switch to"}
      </DropdownMenuLabel>
      {rows.map((row) => (
        <ProfileRateLimitMenuRow
          key={row.profile.profileId}
          row={row}
          readOnly={readOnly}
          usageEntry={usagePresentation.entries.get(
            profileCommitId(row.profile),
          )}
          onPreview={onPreview}
          onFocusPreview={onFocusPreview}
          onSwitchProfile={onSwitchProfile}
        />
      ))}
      {readOnly ? (
        <p className="px-1.5 py-1 text-ui-xs text-muted-foreground">
          Hover or use arrow keys to inspect captured usage.
        </p>
      ) : null}
    </DropdownMenuContent>
  );
}

function ProfileRateLimitMenuRow({
  row,
  readOnly,
  usageEntry,
  onPreview,
  onFocusPreview,
  onSwitchProfile,
}: {
  readonly row: ProfileMenuRow;
  readonly readOnly: boolean;
  readonly usageEntry: ProfileDropdownUsageEntry | undefined;
  readonly onPreview: (profile: ProviderProfile, anchor: HTMLElement) => void;
  readonly onFocusPreview: (
    profile: ProviderProfile,
    anchor: HTMLElement,
  ) => void;
  readonly onSwitchProfile: (profileId: string | null) => void;
}): ReactNode {
  const status = profileMenuStatus(row.profile, usageEntry);
  const preventSwitch = !row.selectable || row.destination === null || readOnly;
  return (
    <DropdownMenuItem
      aria-label={profileMenuAccessibleLabel({
        profile: row.profile,
        status,
        selectable: row.selectable,
        isPrimaryTarget: row.isPrimaryTarget,
        readOnly,
      })}
      aria-disabled={!row.selectable}
      aria-keyshortcuts={usageEntry === undefined ? undefined : "R"}
      className={cn("gap-2 py-1.5 pr-1.5", !row.selectable && "opacity-60")}
      onFocus={(event) => onFocusPreview(row.profile, event.currentTarget)}
      onPointerMove={(event) => onPreview(row.profile, event.currentTarget)}
      onSelect={(event) => {
        if (preventSwitch) {
          event.preventDefault();
          return;
        }
        onSwitchProfile(row.destination.profileId);
      }}
    >
      <AccentDot
        profileId={row.profile.profileId}
        accentColor={row.profile.accentColor}
        label={null}
        variant="inline"
        size="default"
        className={undefined}
      />
      <span className="min-w-0 flex-1 truncate">
        {profileDisplayLabel(row.profile)}
      </span>
      {usageEntry !== undefined ? (
        <ProfileUsageCompactMeter entry={usageEntry} />
      ) : null}
      {status !== null ? (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {status}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

function ProfileRateLimitIdentity({
  harnessId,
  profile,
}: {
  readonly harnessId: GuiHarnessId;
  readonly profile: ProviderProfile;
}): ReactNode {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-1.5 py-0.5 text-ui-xs font-medium text-foreground">
      <HarnessIcon harnessId={harnessId} className="size-3" />
      <AccentDot
        profileId={profile.profileId}
        accentColor={profile.accentColor}
        label={null}
        variant="inline"
        size="default"
        className={undefined}
      />
      <span className="min-w-0 truncate">{profileDisplayLabel(profile)}</span>
    </span>
  );
}
