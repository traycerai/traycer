import { useState, type ReactNode } from "react";
import { AlertTriangle, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { redactEmail } from "@/lib/providers/redact-email";
import { useRemoveProviderProfile } from "@/hooks/providers/use-remove-provider-profile-mutation";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import { ProviderRateLimitForProvider } from "./provider-rate-limit-section";
import { ProviderProfileReauthDialog } from "./provider-profile-reauth-dialog";
import type { FailedProviderProfileAttempt } from "./add-provider-profile-dialog";
import {
  duplicateProfileLabel,
  orderProfiles,
  profileCommitId,
} from "@/components/providers/provider-profile-model";

type ProviderId = ProviderCliState["providerId"];

// Stable module-level reference (not a fresh closure per render) - Settings
// has no picker leader scope, so every row opts out of the shortcut hint.
function noProfileShortcutHint(): ProfileDropdownShortcutHint | null {
  return null;
}

function profileDriftKey(
  providerId: ProviderId,
  profile: ProviderProfile,
): string | null {
  const notice = profile.ambientDriftNotice;
  if (notice === null) return null;
  return `${providerId}:${profile.profileId}:${notice.changedAt}`;
}

interface ProviderProfileScopedSectionProps {
  readonly state: ProviderCliState;
  readonly isSelectedHostLocal: boolean;
  readonly canAddProfile: boolean;
  readonly failedAttempt: FailedProviderProfileAttempt | null;
  readonly onAddProfile: () => void;
  readonly onDismissFailedAttempt: () => void;
  /** Which profile this section is inspecting - local UI state owned by
   *  `ProviderDetail` (never the composer's committed profile or last-used
   *  memory). Controlled so `ProviderDetail` can jump it to a newly created
   *  profile via `AddProviderProfileDialog`'s `onProfileCreated`. */
  readonly selectedProfileId: string | null;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
}

/**
 * Settings > Providers profile-scoped section (multi-profile UX overhaul,
 * T10): the old `ProviderProfilesSection` (list of rows) and the provider's
 * usage-limits card merge into one section. Any provider-reported profile
 * count above zero is headed by the same `ProfileDropdown` the picker uses,
 * even when there is only the terminal/default profile, so the page does not
 * switch visual languages after the first managed profile is added.
 * Everything below the header - the selected profile's details, usage limits,
 * and actions - is scoped to `selectedProfileId`. Renders nothing when the
 * provider reports zero profiles (the pre-multi-profile / flag-off shape);
 * the caller keeps the plain unscoped `ProviderRateLimitForProvider` mounted
 * for that case.
 */
export function ProviderProfileScopedSection(
  props: ProviderProfileScopedSectionProps,
): ReactNode {
  const {
    state,
    isSelectedHostLocal,
    canAddProfile,
    failedAttempt,
    onAddProfile,
    onDismissFailedAttempt,
    selectedProfileId,
    onSelectedProfileIdChange,
  } = props;
  const profiles = state.profiles;
  const [dismissedDriftKeys, setDismissedDriftKeys] = useState<
    readonly string[]
  >([]);

  if (profiles.length === 0) return null;

  const orderedProfiles = orderProfiles(profiles);
  const selectedProfile =
    orderedProfiles.find(
      (candidate) => profileCommitId(candidate) === selectedProfileId,
    ) ?? orderedProfiles[0];
  const providerLabel = PROVIDER_DISPLAY_NAMES[state.providerId];
  const addProfileDisabled = !canAddProfile || !isSelectedHostLocal;
  const addProfileDisabledReason = addProfileDisabled
    ? "Add profiles from a local host with browser sign-in available."
    : undefined;
  const duplicateLabel = duplicateProfileLabel(selectedProfile, profiles);
  const driftKey = profileDriftKey(state.providerId, selectedProfile);
  const driftDismissed =
    driftKey !== null && dismissedDriftKeys.includes(driftKey);

  const dismissDrift = (): void => {
    if (driftKey === null || dismissedDriftKeys.includes(driftKey)) return;
    setDismissedDriftKeys((current) => [...current, driftKey]);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-[min(100%,16rem)] flex-1">
          <ProfileDropdown
            providerLabel={providerLabel}
            profiles={orderedProfiles}
            activeProfileId={selectedProfileId}
            onSelectProfile={onSelectedProfileIdChange}
            onCreateProfile={onAddProfile}
            createProfileDisabled={addProfileDisabled}
            createProfileDisabledReason={addProfileDisabledReason}
            // ⌘⇧-digit isn't wired to Settings - no picker leader scope here.
            shortcutHintForIndex={noProfileShortcutHint}
            contentContainer={null}
            onCloseAutoFocus={null}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-8 shrink-0"
          disabled={addProfileDisabled}
          title={addProfileDisabledReason}
          onClick={onAddProfile}
        >
          <Plus className="size-3.5" />
          Add profile
        </Button>
      </div>
      {addProfileDisabled ? (
        <p className="text-ui-xs text-muted-foreground">
          {addProfileDisabledReason}
        </p>
      ) : null}
      {failedAttempt !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          <span className="min-w-0">
            Sign-in did not finish for{" "}
            {PROVIDER_DISPLAY_NAMES[failedAttempt.providerId]}.
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onAddProfile}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onDismissFailedAttempt}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      {selectedProfile.kind === "ambient" &&
      selectedProfile.ambientDriftNotice !== null &&
      !driftDismissed ? (
        <AmbientDriftNotice
          profile={selectedProfile}
          onDismiss={dismissDrift}
        />
      ) : null}

      <ProviderProfileCard
        providerId={state.providerId}
        profile={selectedProfile}
        profiles={profiles}
      />

      {duplicateLabel !== null ? (
        <ProfileWarning>Same account as {duplicateLabel}</ProfileWarning>
      ) : null}

      <ProviderRateLimitForProvider
        providerId={state.providerId}
        profileId={profileCommitId(selectedProfile)}
        usageUpdatedAt={selectedProfile.usageUpdatedAt}
      />

      {selectedProfile.kind === "managed" ? (
        <ProfileActions
          state={state}
          profile={selectedProfile}
          canOauth={canAddProfile}
          remainingProfilesAfterRemoval={orderedProfiles.filter(
            (candidate) => candidate.profileId !== selectedProfile.profileId,
          )}
          onSelectedProfileIdChange={onSelectedProfileIdChange}
        />
      ) : null}
    </section>
  );
}

function AmbientDriftNotice({
  profile,
  onDismiss,
}: {
  readonly profile: ProviderProfile;
  readonly onDismiss: () => void;
}): ReactNode {
  const currentEmail = profile.identity?.email ?? null;
  const current =
    currentEmail !== null ? redactEmail(currentEmail) : "an unknown account";
  const previousEmail = profile.ambientDriftNotice?.previousEmail ?? null;
  const previous =
    previousEmail !== null ? redactEmail(previousEmail) : "an unknown account";
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-ui-xs text-amber-900 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        Terminal account is now {current}; was {previous}.
      </span>
      <button
        type="button"
        aria-label="Dismiss terminal account change notice"
        className="rounded p-0.5 text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onDismiss}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function ProfileWarning({
  children,
}: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2 text-ui-xs text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function ProfileActions({
  state,
  profile,
  canOauth,
  remainingProfilesAfterRemoval,
  onSelectedProfileIdChange,
}: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly canOauth: boolean;
  /** The provider's other profiles, ordered - what stays once `profile` is
   *  removed. Lets a successful removal land the section on a profile that
   *  still exists instead of leaving `selectedProfileId` pointed at the one
   *  just deleted. */
  readonly remainingProfilesAfterRemoval: ReadonlyArray<ProviderProfile>;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
}): ReactNode {
  const providerId = state.providerId;
  const removeProfile = useRemoveProviderProfile();
  const [reauthOpen, setReauthOpen] = useState(false);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canOauth}
          title={
            canOauth
              ? undefined
              : "Sign in again requires a local host with browser sign-in available."
          }
          onClick={() => setReauthOpen(true)}
          className="text-ui-sm"
        >
          <RefreshCw className="size-3.5" />
          Sign in again
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={removeProfile.isPending}
          onClick={() => setConfirmRemoveOpen(true)}
          className="text-ui-sm text-destructive"
        >
          <Trash2 className="size-3.5" />
          Remove this profile
        </Button>
      </div>
      {removeProfile.error !== null ? (
        <p className="text-ui-xs text-destructive">
          {removeProfile.error.message}
        </p>
      ) : null}
      {reauthOpen ? (
        <ProviderProfileReauthDialog
          state={state}
          profile={profile}
          open
          onOpenChange={setReauthOpen}
        />
      ) : null}
      <ConfirmDestructiveDialog
        open={confirmRemoveOpen}
        onOpenChange={setConfirmRemoveOpen}
        title={`Remove ${profile.label}?`}
        description={`Chats that ran on ${profile.label} will show it as removed. Running sessions on this profile must be stopped first.`}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={removeProfile.isPending}
        onConfirm={() =>
          removeProfile.mutate(
            { providerId, profileId: profile.profileId },
            {
              onSuccess: () => {
                setConfirmRemoveOpen(false);
                const nextProfile = remainingProfilesAfterRemoval.at(0);
                onSelectedProfileIdChange(
                  nextProfile === undefined
                    ? null
                    : profileCommitId(nextProfile),
                );
              },
            },
          )
        }
      />
    </div>
  );
}
