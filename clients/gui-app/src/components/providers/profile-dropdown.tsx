import { CheckIcon, ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  profileCommitId,
  profileDisplayLabel,
  profileAuthStatusText,
  profileRowStatusSuffix,
  orderProfiles,
  type ProfileRowAdmission,
} from "@/components/providers/provider-profile-model";
import {
  profileUsageAccessibleStatus,
  type ProfileDropdownUsageEntry,
  type ProfileDropdownUsagePresentation,
} from "@/components/providers/profile-dropdown-usage";
import { ProfileUsageSidecar } from "@/components/providers/profile-usage-sidecar";
import { isProfileUsageSidecarTarget } from "@/components/providers/profile-usage-sidecar-target";
import { ProfileUsageCompactMeter } from "@/components/providers/profile-usage-compact-meter";
import { cn } from "@/lib/utils";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import {
  useId,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
const PROFILE_DROPDOWN_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Enter",
  "Escape",
]);

/** A row's ⌘⇧-digit shortcut hint - `digit` drives the row's test id,
 *  `label` is the displayed chord text. Keeping both explicit (rather than
 *  deriving the digit from `label`) keeps this component free of any
 *  keybinding-formatting knowledge. */
export interface ProfileDropdownShortcutHint {
  readonly digit: string;
  readonly label: string;
}

interface ProfileDropdownProps {
  readonly providerLabel: string;
  /** 2+ selectable profiles - progressive disclosure (no dropdown under 2) is
   *  the caller's gate, not this component's. */
  readonly profiles: ReadonlyArray<ProviderProfile>;
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onCreateProfile: () => void;
  readonly createProfileDisabled: boolean;
  readonly createProfileDisabledReason: string | undefined;
  /** Per-row shortcut hint, or a function that always returns `null` to opt
   *  out entirely. The picker wrapper supplies live ⌘⇧-digit hints (it's
   *  live-dispatchable there); Settings passes an always-null function -
   *  ⌘⇧-digit isn't wired to that surface. This component renders whatever
   *  it's given and owns no keybinding-formatting policy itself. */
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  /** Portal target for nested surfaces. The model picker passes its popover
   *  node so dropdown outside-click handling does not dismiss the whole picker;
   *  Settings passes null to keep the default document-level portal. */
  readonly contentContainer: HTMLElement | null;
  /** Non-null overrides Radix's default close-focus-return-to-trigger, e.g. so
   *  the picker can send focus back to its search input instead. Null keeps
   *  the default (Settings has no outer surface to defer to). */
  readonly onCloseAutoFocus: (() => void) | null;
  /** Picker-only cached usage presentation. Settings passes `null`, which
   *  preserves the identity-only rows and mounts no usage observers/sidecar. */
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
  /** Whether this provider has a managed profile and therefore supports
   *  per-profile eligibility controls. Terminal-only providers pass false. */
  readonly profileEnablementAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly profileEnablementDisabledReason: (
    profileId: string | null,
  ) => string | null;
  /** Settings selects disabled rows for maintenance; run-target pickers do not. */
  readonly disabledProfilesSelectable: boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
  /** Per-row admission override keyed by `profileCommitId` (the TUI continue-
   *  under-another-profile dialog's bulk fork-admission preflight). `null`
   *  for every other caller - no row is overridden, matching today's
   *  behavior exactly. */
  readonly admissionByProfileId: ReadonlyMap<
    string | null,
    ProfileRowAdmission
  > | null;
}

/**
 * Shared profile switcher (multi-profile UX overhaul, 2026-07-09 wireframe):
 * one compact dropdown reused by the model picker (replacing the old chip
 * strip) and Settings' profile-scoped provider section. Closed: accent dot +
 * active profile name + chevron. Open: one row per profile (dot + name +
 * status suffix for signed-out/unavailable + optional shortcut hint), then a
 * separator and a final "Create new profile" row.
 */
export function ProfileDropdown(props: ProfileDropdownProps) {
  const {
    providerLabel,
    profiles,
    activeProfileId,
    onSelectProfile,
    onCreateProfile,
    createProfileDisabled,
    createProfileDisabledReason,
    shortcutHintForIndex,
    contentContainer,
    onCloseAutoFocus,
    usagePresentation,
    profileEnablementAvailable,
    profileEnablementPending,
    profileEnablementDisabledReason,
    disabledProfilesSelectable,
    onSetProfileEnabled,
    admissionByProfileId,
  } = props;
  const orderedProfiles = orderProfiles(profiles);
  const rowIdPrefix = useId();
  const activeProfile =
    orderedProfiles.find(
      (profile) => profileCommitId(profile) === activeProfileId,
    ) ?? orderedProfiles[0];
  const activeCommitId = profileCommitId(activeProfile);
  const [open, setOpen] = useState(false);
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(
    activeCommitId,
  );
  const [previewAnchor, setPreviewAnchor] = useState<HTMLElement | null>(null);
  const previewProfile = orderedProfiles.find(
    (profile) => profileCommitId(profile) === previewProfileId,
  );
  const previewEntry = usagePresentation?.entries.get(previewProfileId);

  const preview = (profileId: string | null, anchor: HTMLElement): void => {
    setPreviewProfileId(profileId);
    setPreviewAnchor(anchor);
  };
  const rowContext: ProfileDropdownRowContext = {
    activeProfileId,
    rowIdPrefix,
    previewProfileId,
    onPreview: preview,
    onPreviewAnchor: setPreviewAnchor,
    shortcutHintForIndex,
    usagePresentation,
    admissionByProfileId,
    profileEnablementAvailable,
    profileEnablementPending,
    profileEnablementDisabledReason,
    disabledProfilesSelectable,
    onSelectProfile,
    onSetProfileEnabled,
  };

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPreviewAnchor(null);
          return;
        }
        setPreviewProfileId(activeCommitId);
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${providerLabel} profile: ${profileDisplayLabel(activeProfile)}${terminalBadgeSuffix(activeProfile)}${activeProfile.enabled ? "" : ", Disabled"}`}
          className="flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 text-ui-sm text-foreground outline-none transition-colors hover:bg-input/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-open:bg-input/30 dark:bg-input/30 dark:hover:bg-input/50"
        >
          <AccentDot
            profileId={activeProfile.profileId}
            accentColor={activeProfile.accentColor}
            label={null}
            variant="inline"
            size="default"
            className={undefined}
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate text-left font-medium">
              {profileDisplayLabel(activeProfile)}
            </span>
            {activeProfile.kind === "ambient" ? <TerminalProfileBadge /> : null}
            {!activeProfile.enabled ? (
              <span className="shrink-0 text-muted-foreground">Disabled</span>
            ) : null}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        container={contentContainer}
        className="min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-lg p-1"
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus === null) return;
          event.preventDefault();
          onCloseAutoFocus();
        }}
        onInteractOutside={(event) => {
          if (isProfileUsageSidecarTarget(event.target)) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // Item-level navigation/selection runs before the event bubbles to
          // content. At content, Radix calls this handler before its own later
          // composed callback; stopPropagation blocks enclosing React handlers
          // without cancelling either same-target continuation.
          if (PROFILE_DROPDOWN_KEYS.has(event.key)) event.stopPropagation();
          if (
            usagePresentation === null ||
            event.key.toLowerCase() !== "r" ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const entry = usagePresentation.entries.get(previewProfileId);
          if (
            entry === undefined ||
            !entry.fetchEligible ||
            entry.refreshStatus !== "idle" ||
            !usagePresentation.isHostReady
          ) {
            return;
          }
          event.preventDefault();
          void entry.refresh();
        }}
      >
        {orderedProfiles.map((profile, index) => (
          <ProfileDropdownRow
            key={profile.profileId}
            profile={profile}
            index={index}
            shortcutIndex={
              orderedProfiles
                .slice(0, index)
                .filter(
                  (candidate) =>
                    candidate.enabled &&
                    !profileEnablementPending(profileCommitId(candidate)),
                ).length
            }
            context={rowContext}
          />
        ))}
        <DropdownMenuSeparator />
        <TooltipWrapper
          label={createProfileDisabledReason}
          side="top"
          sideOffset={undefined}
          align={undefined}
        >
          {/* `flex w-full`, not `inline-flex`: the guard becomes the menu
              content's layout child, and a shrink-to-fit one would narrow the
              row to its text. */}
          <span className="flex w-full">
            <DropdownMenuItem
              disabled={createProfileDisabled}
              onSelect={onCreateProfile}
            >
              <Plus className="size-3.5" />
              Create new profile
            </DropdownMenuItem>
          </span>
        </TooltipWrapper>
      </DropdownMenuContent>
      {usagePresentation !== null &&
      open &&
      previewProfile !== undefined &&
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

interface ProfileDropdownRowContext {
  readonly activeProfileId: string | null;
  readonly rowIdPrefix: string;
  readonly previewProfileId: string | null;
  readonly onPreview: (profileId: string | null, anchor: HTMLElement) => void;
  readonly onPreviewAnchor: (anchor: HTMLElement) => void;
  readonly shortcutHintForIndex: ProfileDropdownProps["shortcutHintForIndex"];
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
  readonly admissionByProfileId: ProfileDropdownProps["admissionByProfileId"];
  readonly profileEnablementAvailable: boolean;
  readonly profileEnablementPending: ProfileDropdownProps["profileEnablementPending"];
  readonly profileEnablementDisabledReason: ProfileDropdownProps["profileEnablementDisabledReason"];
  readonly disabledProfilesSelectable: boolean;
  readonly onSelectProfile: ProfileDropdownProps["onSelectProfile"];
  readonly onSetProfileEnabled: ProfileDropdownProps["onSetProfileEnabled"];
}

interface ProfileDropdownRowState {
  readonly statusSuffix: string | null;
  readonly commitId: string | null;
  readonly label: string;
  readonly shortcutHint: ProfileDropdownShortcutHint | null;
  readonly usageEntry: ProfileDropdownUsageEntry | undefined;
  readonly selected: boolean;
  readonly admission: ProfileRowAdmission | null;
  readonly rowDisabled: boolean;
  readonly accessibleLabel: string;
}

function ProfileDropdownRow(props: {
  readonly profile: ProviderProfile;
  readonly index: number;
  readonly shortcutIndex: number;
  readonly context: ProfileDropdownRowContext;
}): ReactNode {
  const state = computeProfileRowState({
    profile: props.profile,
    index: props.shortcutIndex,
    activeProfileId: props.context.activeProfileId,
    shortcutHintForIndex: props.context.shortcutHintForIndex,
    usagePresentation: props.context.usagePresentation,
    admissionByProfileId: props.context.admissionByProfileId,
  });
  const enablementPending = props.context.profileEnablementPending(
    state.commitId,
  );
  const enablementDisabledReason =
    props.context.profileEnablementDisabledReason(state.commitId);
  const selectionId = `${props.context.rowIdPrefix}-profile-${props.index}`;
  const selection = (
    <ProfileSelectionControl
      profile={props.profile}
      state={state}
      selectionId={selectionId}
      enablementPending={enablementPending}
      context={props.context}
    />
  );
  return (
    <div
      role="group"
      aria-label={`${state.label} profile controls`}
      className={cn(
        "flex w-full items-center gap-1 rounded-sm pr-1",
        profileRowFaded(props.profile, state, enablementPending) &&
          "opacity-60",
      )}
    >
      {admissionTooltipRow(state.admission, selection)}
      <ProfileEnablementSwitch
        available={props.context.profileEnablementAvailable}
        profile={props.profile}
        commitId={state.commitId}
        label={state.label}
        selectionId={selectionId}
        pending={enablementPending}
        disabledReason={enablementDisabledReason}
        onSetProfileEnabled={props.context.onSetProfileEnabled}
      />
    </div>
  );
}

function ProfileSelectionControl(props: {
  readonly profile: ProviderProfile;
  readonly state: ProfileDropdownRowState;
  readonly selectionId: string;
  readonly enablementPending: boolean;
  readonly context: ProfileDropdownRowContext;
}): ReactNode {
  const { profile, state, context } = props;
  const visibleDisabledReason = visibleProfileDisabledReason(state);
  return (
    <DropdownMenuItem
      id={props.selectionId}
      ref={(node) => {
        if (state.commitId === context.previewProfileId && node !== null) {
          context.onPreviewAnchor(node);
        }
      }}
      disabled={state.rowDisabled}
      aria-disabled={profileSelectionAriaDisabled(
        profile,
        state.rowDisabled,
        context.disabledProfilesSelectable,
        props.enablementPending,
      )}
      aria-label={
        props.enablementPending
          ? `${state.accessibleLabel}, Updating`
          : state.accessibleLabel
      }
      aria-keyshortcuts={state.usageEntry?.fetchEligible ? "R" : undefined}
      aria-current={state.selected ? "true" : undefined}
      className={cn(
        "min-w-0 flex-1 pr-1.5",
        visibleDisabledReason !== null && "flex-col items-start gap-0.5",
      )}
      onFocus={(event) =>
        context.onPreview(state.commitId, event.currentTarget)
      }
      onPointerMove={(event) =>
        context.onPreview(state.commitId, event.currentTarget)
      }
      onKeyDown={focusSiblingProfileSwitch}
      onSelect={(event) => {
        if (
          profileSelectionBlocked(
            profile,
            context.disabledProfilesSelectable,
            props.enablementPending,
          )
        ) {
          event.preventDefault();
          return;
        }
        context.onSelectProfile(state.commitId);
      }}
    >
      <ProfileSelectionContents
        profile={profile}
        state={state}
        enablementPending={props.enablementPending}
        activeProfileId={context.activeProfileId}
      />
      {visibleDisabledReason !== null ? (
        <span className="pl-[22px] text-left text-[11px] leading-tight text-muted-foreground">
          {visibleDisabledReason}
        </span>
      ) : null}
    </DropdownMenuItem>
  );
}

function ProfileSelectionContents(props: {
  readonly profile: ProviderProfile;
  readonly state: ProfileDropdownRowState;
  readonly enablementPending: boolean;
  readonly activeProfileId: string | null;
}): ReactNode {
  const { profile, state } = props;
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5">
      <AccentDot
        profileId={profile.profileId}
        accentColor={profile.accentColor}
        label={null}
        variant="inline"
        size="default"
        className={undefined}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate">{state.label}</span>
        {profile.kind === "ambient" ? <TerminalProfileBadge /> : null}
      </span>
      {state.statusSuffix !== null ? (
        <span className="shrink-0 text-muted-foreground">
          {state.statusSuffix}
        </span>
      ) : null}
      <ProfileEnablementLabel
        enabled={profile.enabled}
        pending={props.enablementPending}
      />
      {state.usageEntry !== undefined ? (
        <ProfileUsageCompactMeter entry={state.usageEntry} />
      ) : null}
      <ProfileShortcut
        shortcutHint={state.shortcutHint}
        rowDisabled={state.rowDisabled}
        profileEnabled={profile.enabled}
        enablementPending={props.enablementPending}
      />
      <span className="pointer-events-none flex size-4 shrink-0 items-center justify-center">
        {state.commitId === props.activeProfileId ? (
          <CheckIcon className="size-4" />
        ) : null}
      </span>
    </span>
  );
}

function ProfileEnablementLabel(props: {
  readonly enabled: boolean;
  readonly pending: boolean;
}): ReactNode {
  if (props.pending) {
    return <span className="shrink-0 text-muted-foreground">Updating</span>;
  }
  if (!props.enabled) {
    return <span className="shrink-0 text-muted-foreground">Disabled</span>;
  }
  return null;
}

function ProfileShortcut(props: {
  readonly shortcutHint: ProfileDropdownShortcutHint | null;
  readonly rowDisabled: boolean;
  readonly profileEnabled: boolean;
  readonly enablementPending: boolean;
}): ReactNode {
  if (
    props.shortcutHint === null ||
    props.rowDisabled ||
    !props.profileEnabled ||
    props.enablementPending
  ) {
    return null;
  }
  return (
    <DropdownMenuShortcut
      data-testid={`model-profile-digit-${props.shortcutHint.digit}`}
    >
      <Kbd className="font-mono tabular-nums">{props.shortcutHint.label}</Kbd>
    </DropdownMenuShortcut>
  );
}

function ProfileEnablementSwitch(props: {
  readonly available: boolean;
  readonly profile: ProviderProfile;
  readonly commitId: string | null;
  readonly label: string;
  readonly selectionId: string;
  readonly pending: boolean;
  readonly disabledReason: string | null;
  readonly onSetProfileEnabled: ProfileDropdownProps["onSetProfileEnabled"];
}): ReactNode {
  if (!props.available) return null;
  return (
    <TooltipWrapper
      label={props.disabledReason}
      side="right"
      sideOffset={6}
      align={undefined}
    >
      <Switch
        aria-label={`Allow agents to use ${props.label}`}
        checked={props.profile.enabled}
        disabled={props.pending}
        aria-disabled={props.disabledReason !== null || undefined}
        className="relative h-3.5 w-6 transition-colors duration-150 before:absolute before:inset-x-0 before:-inset-y-[5px] before:content-[''] [&>[data-slot=switch-thumb]]:size-3"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          document.getElementById(props.selectionId)?.focus();
        }}
        onCheckedChange={(enabled) => {
          if (props.disabledReason !== null) return;
          props.onSetProfileEnabled(props.commitId, enabled);
        }}
      />
    </TooltipWrapper>
  );
}

function profileRowFaded(
  profile: ProviderProfile,
  state: ProfileDropdownRowState,
  enablementPending: boolean,
): boolean {
  return (
    state.statusSuffix !== null ||
    state.rowDisabled ||
    !profile.enabled ||
    enablementPending
  );
}

function visibleProfileDisabledReason(
  state: ProfileDropdownRowState,
): string | null {
  if (!state.rowDisabled || state.admission === null) return null;
  return state.admission.reason;
}

function profileSelectionAriaDisabled(
  profile: ProviderProfile,
  rowDisabled: boolean,
  disabledProfilesSelectable: boolean,
  enablementPending: boolean,
): true | undefined {
  if (rowDisabled || enablementPending) return true;
  if (!profile.enabled && !disabledProfilesSelectable) return true;
  return undefined;
}

function profileSelectionBlocked(
  profile: ProviderProfile,
  disabledProfilesSelectable: boolean,
  enablementPending: boolean,
): boolean {
  return (!profile.enabled && !disabledProfilesSelectable) || enablementPending;
}

function focusSiblingProfileSwitch(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowRight") return;
  const group = event.currentTarget.closest("[role='group']");
  const profileSwitch = group?.querySelector("[role='switch']");
  if (!(profileSwitch instanceof HTMLElement)) return;
  event.preventDefault();
  profileSwitch.focus();
}

/** Every per-row derived value the `.map()` callback needs, computed in one
 *  place - split out purely to keep that callback's branch count down. */
function computeProfileRowState(input: {
  readonly profile: ProviderProfile;
  readonly index: number;
  readonly activeProfileId: string | null;
  readonly shortcutHintForIndex: (
    index: number,
  ) => ProfileDropdownShortcutHint | null;
  readonly usagePresentation: ProfileDropdownUsagePresentation | null;
  readonly admissionByProfileId: ReadonlyMap<
    string | null,
    ProfileRowAdmission
  > | null;
}): ProfileDropdownRowState {
  const statusSuffix = profileRowStatusSuffix(input.profile);
  const commitId = profileCommitId(input.profile);
  const label = profileDisplayLabel(input.profile);
  const shortcutHint = input.shortcutHintForIndex(input.index);
  const usageEntry = input.usagePresentation?.entries.get(commitId);
  const selected = commitId === input.activeProfileId;
  const admission = input.admissionByProfileId?.get(commitId) ?? null;
  const rowDisabled = admission?.disabled === true;
  const accessibleLabel = profileRowAccessibleLabel({
    label,
    profile: input.profile,
    selected,
    statusSuffix,
    usageEntry,
    admissionReason: admission?.reason ?? null,
    enabled: input.profile.enabled,
  });
  return {
    statusSuffix,
    commitId,
    label,
    shortcutHint,
    usageEntry,
    selected,
    admission,
    rowDisabled,
    accessibleLabel,
  };
}

/** Wraps a disabled-with-reason row in a tooltip; passes an admitted (or
 *  reasonless) row through unchanged. Split out of the row `.map()` purely to
 *  keep that callback's branch count down. */
function admissionTooltipRow(
  admission: ProfileRowAdmission | null,
  row: ReactNode,
): ReactNode {
  if (admission === null || admission.reason === null) return row;
  return (
    <TooltipWrapper
      label={admission.reason}
      side="right"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="flex w-full">{row}</span>
    </TooltipWrapper>
  );
}

/** Marks the terminal/default-CLI-login profile next to its name, on both the
 *  closed trigger and the open rows. */
function TerminalProfileBadge() {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground"
    >
      Terminal
    </Badge>
  );
}

/** Restates the visual `TerminalProfileBadge` for aria-labels - both the
 *  trigger and the rows carry aria-labels that replace their text content, so
 *  the badge is invisible to AT without this suffix. */
function terminalBadgeSuffix(profile: ProviderProfile): string {
  return profile.kind === "ambient" ? ", Terminal" : "";
}

function profileRowAccessibleLabel(input: {
  readonly label: string;
  readonly profile: ProviderProfile;
  readonly selected: boolean;
  readonly statusSuffix: string | null;
  readonly usageEntry: ProfileDropdownUsageEntry | undefined;
  /** The row's admission-disabled reason (`ProfileRowAdmission.reason`), when
   *  set. Radix skips a disabled item during roving-focus arrow navigation,
   *  so the tooltip that also renders this text is hover-only for keyboard/AT
   *  users - folding it into the accessible name is what makes the reason
   *  perceivable to them at all. */
  readonly admissionReason: string | null;
  readonly enabled: boolean;
}): string {
  const label = `${input.label}${terminalBadgeSuffix(input.profile)}`;
  const base = profileRowAccessibleLabelBase(input, label);
  const eligibility = input.enabled ? base : `${base}, Disabled`;
  if (input.admissionReason === null) return eligibility;
  return `${eligibility}, ${input.admissionReason}`;
}

function profileRowAccessibleLabelBase(
  input: {
    readonly profile: ProviderProfile;
    readonly selected: boolean;
    readonly statusSuffix: string | null;
    readonly usageEntry: ProfileDropdownUsageEntry | undefined;
  },
  label: string,
): string {
  if (input.usageEntry === undefined) {
    if (input.statusSuffix === null) return label;
    return `${label}, ${input.statusSuffix}`;
  }
  const selection = input.selected ? "Selected" : "Not selected";
  return `${label}, ${profileAuthStatusText(input.profile)}, ${selection}, ${profileUsageAccessibleStatus(input.usageEntry.projection)}`;
}
