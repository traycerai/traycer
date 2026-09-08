import {
  AlertTriangle,
  Copy,
  Plus,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { AccentDot } from "@/components/providers/accent-dot";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import {
  duplicateProfileLabel,
  profileAuthStatusText,
  profileCommitId,
  profileEligibilityToggleDisabledReason,
} from "@/components/providers/provider-profile-model";
import {
  isRateLimitProfileFetchEligible,
  resolveRateLimitFetchEligibility,
} from "@/lib/rate-limit-providers";
import { ProviderProfilesRefreshButton } from "./provider-rate-limit-section";

// Stable module-level reference (not a fresh closure per render) - Settings
// has no picker leader scope, so every row opts out of the shortcut hint.
function noProfileShortcutHint(): ProfileDropdownShortcutHint | null {
  return null;
}

function selectedProfileFetchEligible(
  state: ProviderCliState,
  profile: ProviderProfile,
): boolean {
  return isRateLimitProfileFetchEligible(
    resolveRateLimitFetchEligibility(state),
    profile,
  );
}

export interface ProfileSwitcherProps {
  readonly state: ProviderCliState;
  /** The resolved selection (store value, fallen back through
   *  `resolveSelectedProfileId`) - `ProviderDetail` owns the read/write. */
  readonly activeProfileId: string | null;
  readonly onSelectProfile: (profileId: string | null) => void;
  readonly onAddProfile: () => void;
  readonly addProfileDisabled: boolean;
  readonly addProfileDisabledReason: string | null;
  /** Opens the existing rename/recolor/enable/remove/re-sign-in dialog for the
   *  selected profile (D25 "Manage"). `null` when there is no profile to
   *  manage (a defensive empty-`profiles` read from a pre-D05 host). */
  readonly onManageProfile: (() => void) | null;
  /** Gated on `useCopySettingsSupported(hostId)` (D21: both
   *  `providers.previewCopySettings` and `providers.applyCopySettings` must
   *  be negotiated) - the caller decides visibility by whether it passes a
   *  function here. `null` hides the entry entirely (an older host, or no
   *  selected profile). The Copy settings PAGE this opens is W2-T11's; this
   *  is the seam it plugs into. */
  readonly onOpenCopySettings: (() => void) | null;
  readonly profileEnablementAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
  readonly profileStatusRefreshAvailable: boolean;
}

/**
 * Settings ▸ Providers persistent profile context (D25): mounted once per
 * provider, above the tab rail, never inside a tab body. Owns the profile
 * SELECTOR and its lifecycle entry points (Add profile / Manage / Copy
 * settings…); every tab below it renders scoped to `activeProfileId`, which
 * the caller (`ProviderDetail`) reads from and writes to
 * `providers-profile-selection-store.ts`.
 *
 * Reuses `ProfileDropdown` unchanged for the selector itself - this file adds
 * only the eyebrow, the compact single-profile chip, the Manage / Copy
 * settings affordances, and the two pieces lifted out of the deleted
 * `ProviderProfileScopedSection`: the combined refresh button and the
 * duplicate-account warning.
 */
export function ProfileSwitcher(props: ProfileSwitcherProps): ReactNode {
  const {
    state,
    activeProfileId,
    onSelectProfile,
    onAddProfile,
    addProfileDisabled,
    addProfileDisabledReason,
    onManageProfile,
    onOpenCopySettings,
    profileEnablementAvailable,
    profileEnablementPending,
    onSetProfileEnabled,
    profileStatusRefreshAvailable,
  } = props;
  const profiles = state.profiles;
  const providerLabel = PROVIDER_DISPLAY_NAMES[state.providerId];
  const selectedProfile =
    profiles.find(
      (candidate) => profileCommitId(candidate) === activeProfileId,
    ) ??
    profiles.at(0) ??
    null;
  const duplicateLabel =
    selectedProfile !== null
      ? duplicateProfileLabel(selectedProfile, profiles)
      : null;
  const showDropdown = profiles.length >= 2;
  // D11/D21: whether this provider supports managed profiles at all - gates
  // the compact chip's Add-profile affordance (D25).
  const profilesSupported = state.profilesSupported ?? false;

  return (
    <section
      data-slot="profile-switcher"
      className="flex w-full flex-col gap-2 border-b border-border/60 pb-4"
    >
      <div className="flex items-center justify-between gap-2">
        {/* Decorative eyebrow: `ProfileDropdown`'s trigger (and the compact
            chip) carry their own `aria-label`, so this names nothing to AT
            and would only double the row up. */}
        <span
          aria-hidden="true"
          className="text-ui-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          Profile
        </span>
        {selectedProfile !== null ? (
          <ProviderProfilesRefreshButton
            providerId={state.providerId}
            profileId={profileCommitId(selectedProfile)}
            usageUpdatedAt={selectedProfile.usageUpdatedAt}
            fetchEligible={selectedProfileFetchEligible(state, selectedProfile)}
            maintenanceAvailable={profileStatusRefreshAvailable}
          />
        ) : null}
      </div>
      {showDropdown ? (
        <ProfileDropdown
          providerLabel={providerLabel}
          profiles={profiles}
          activeProfileId={activeProfileId}
          onSelectProfile={onSelectProfile}
          onCreateProfile={onAddProfile}
          createProfileDisabled={addProfileDisabled}
          createProfileDisabledReason={addProfileDisabledReason ?? undefined}
          // ⌘⇧-digit isn't wired to Settings - no picker leader scope here.
          shortcutHintForIndex={noProfileShortcutHint}
          contentContainer={null}
          onCloseAutoFocus={null}
          usagePresentation={null}
          profileEnablementPending={profileEnablementPending}
          eligibilityControls={
            profileEnablementAvailable
              ? {
                  pending: profileEnablementPending,
                  disabledReason: (profile) =>
                    profileEligibilityToggleDisabledReason(
                      state.enabled,
                      profile,
                      profiles,
                    ),
                  onSetEnabled: onSetProfileEnabled,
                }
              : null
          }
          admissionByProfileId={null}
        />
      ) : (
        <DefaultAccountChip profile={selectedProfile} />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!showDropdown && profilesSupported ? (
          <TooltipWrapper
            label={addProfileDisabledReason}
            side="top"
            sideOffset={6}
            align="start"
          >
            <span className="inline-flex">
              <ProfileSwitcherAction
                icon={Plus}
                label="Add profile"
                disabled={addProfileDisabled}
                onClick={onAddProfile}
              />
            </span>
          </TooltipWrapper>
        ) : null}
        {onManageProfile !== null ? (
          <ProfileSwitcherAction
            icon={Settings2}
            label="Manage"
            disabled={false}
            onClick={onManageProfile}
          />
        ) : null}
        {onOpenCopySettings !== null ? (
          <ProfileSwitcherAction
            icon={Copy}
            label="Copy settings…"
            disabled={false}
            onClick={onOpenCopySettings}
          />
        ) : null}
      </div>
      {duplicateLabel !== null ? (
        <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-ui-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">Same account as {duplicateLabel}</span>
        </div>
      ) : null}
    </section>
  );
}

function ProfileSwitcherAction(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  const Icon = props.icon;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="shrink-0"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon data-icon="inline-start" />
      {props.label}
    </Button>
  );
}

/**
 * Single-profile providers (D25): a non-interactive chip in place of the
 * dropdown. Always reads "Default account" - the vocabulary is fixed (D26)
 * and does not follow the underlying row's own label.
 */
function DefaultAccountChip({
  profile,
}: {
  readonly profile: ProviderProfile | null;
}): ReactNode {
  return (
    <div className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-ui-sm text-foreground">
      {profile !== null ? (
        <AccentDot
          profileId={profile.profileId}
          accentColor={profile.accentColor}
          label={null}
          variant="inline"
          size="default"
          className={undefined}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate font-medium">
        Default account
      </span>
      {profile !== null ? (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {profileAuthStatusText(profile)}
        </span>
      ) : null}
    </div>
  );
}
