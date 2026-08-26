import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  LogIn,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { redactEmail } from "@/lib/providers/redact-email";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import {
  EmbeddedProviderRateLimitForProvider,
  ProviderProfilesRefreshButton,
} from "./provider-rate-limit-section";
import { ProfileEditDialog } from "./provider-profile-edit-dialog";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { FailedProviderProfileAttempt } from "./add-provider-profile-dialog";
import {
  duplicateProfileLabel,
  profileEligibilityToggleDisabledReason,
  profileAuthStatusText,
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";
import {
  isRateLimitProfileFetchEligible,
  resolveRateLimitFetchEligibility,
} from "@/lib/rate-limit-providers";

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

function profileRateLimitFetchEligible(
  state: ProviderCliState,
  profile: ProviderProfile,
): boolean {
  return isRateLimitProfileFetchEligible(
    resolveRateLimitFetchEligibility(state),
    profile,
  );
}

interface ProviderProfileScopedSectionProps {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly canAddProfile: boolean;
  /**
   * Why sign-in is unavailable, or null when it is available. Supplied rather
   * than reconstructed here: the panel owns the three facts that decide it
   * (host locality, browser-sign-in capability, managed-pack readiness), and a
   * second derivation is how the previous hardcoded sentence went stale.
   */
  readonly signInUnavailableHint: string | null;
  readonly startInReauth: boolean;
  readonly failedAttempt: FailedProviderProfileAttempt | null;
  readonly onAddProfile: () => void;
  readonly onDismissFailedAttempt: () => void;
  /** Which profile this section is inspecting - local UI state owned by
   *  `ProviderDetail` (never the composer's committed profile or last-used
   *  memory). Controlled so `ProviderDetail` can jump it to a newly created
   *  profile via `AddProviderProfileDialog`'s `onProfileCreated`. */
  readonly selectedProfileId: string | null;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
  readonly profileEnablementAvailable: boolean;
  readonly profileStatusRefreshAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
}

function ProfileScopedSectionMessages(props: {
  readonly selectedProfile: ProviderProfile;
  readonly addProfileDisabled: boolean;
  readonly addProfileDisabledReason: string | null;
  readonly failedAttempt: FailedProviderProfileAttempt | null;
  readonly onAddProfile: () => void;
  readonly onDismissFailedAttempt: () => void;
  readonly driftDismissed: boolean;
  readonly onDismissDrift: () => void;
  readonly duplicateLabel: string | null;
}): ReactNode {
  return (
    <>
      {props.addProfileDisabled ? (
        <p className="text-ui-xs text-muted-foreground">
          {props.addProfileDisabledReason}
        </p>
      ) : null}
      {props.failedAttempt !== null ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-xs text-destructive">
          <span className="min-w-0">
            Sign-in did not finish for{" "}
            {PROVIDER_DISPLAY_NAMES[props.failedAttempt.providerId]}.
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={props.onAddProfile}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={props.onDismissFailedAttempt}
            >
              Dismiss
            </Button>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Provider sign-in failed",
                message: "Sign-in did not finish for a provider profile.",
                code: null,
                source: "Provider sign-in",
              })}
              presentation="icon"
              className={undefined}
            />
          </div>
        </div>
      ) : null}
      {props.selectedProfile.kind === "ambient" &&
      props.selectedProfile.ambientDriftNotice !== null &&
      !props.driftDismissed ? (
        <AmbientDriftNotice
          profile={props.selectedProfile}
          onDismiss={props.onDismissDrift}
        />
      ) : null}
      {props.duplicateLabel !== null ? (
        <ProfileWarning>Same account as {props.duplicateLabel}</ProfileWarning>
      ) : null}
    </>
  );
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
    hostId,
    isSelectedHostLocal,
    canAddProfile,
    signInUnavailableHint,
    startInReauth,
    failedAttempt,
    onAddProfile,
    onDismissFailedAttempt,
    selectedProfileId,
    onSelectedProfileIdChange,
    profileEnablementAvailable,
    profileStatusRefreshAvailable,
    profileEnablementPending,
    onSetProfileEnabled,
  } = props;
  const profiles = state.profiles;
  const [dismissedDriftKeys, setDismissedDriftKeys] = useState<
    readonly string[]
  >([]);
  const [editProfileOpen, setEditProfileOpen] = useState(startInReauth);
  const [editSessionId, setEditSessionId] = useState(0);
  const [editIntent, setEditIntent] = useState<"manage" | "sign-in">(() =>
    startInReauth ? "sign-in" : "manage",
  );

  if (profiles.length === 0) return null;

  const selectedProfile =
    profiles.find(
      (candidate) => profileCommitId(candidate) === selectedProfileId,
    ) ?? profiles[0];
  const providerLabel = PROVIDER_DISPLAY_NAMES[state.providerId];
  const addProfileDisabled = !canAddProfile || !isSelectedHostLocal;
  // `TooltipWrapper` degrades to a passthrough Slot for both `null` and
  // `undefined` labels; `null` here is just the plainer of the two spellings.
  const addProfileDisabledReason = addProfileDisabled
    ? "Add profiles from a local host with browser sign-in available."
    : null;
  const duplicateLabel = duplicateProfileLabel(selectedProfile, profiles);
  const driftKey = profileDriftKey(state.providerId, selectedProfile);
  const driftDismissed =
    driftKey !== null && dismissedDriftKeys.includes(driftKey);

  const dismissDrift = (): void => {
    if (driftKey === null || dismissedDriftKeys.includes(driftKey)) return;
    setDismissedDriftKeys((current) => [...current, driftKey]);
  };

  const openProfileEditor = (): void => {
    setEditIntent("manage");
    setEditSessionId((current) => current + 1);
    setEditProfileOpen(true);
  };

  const openProfileSignIn = (): void => {
    setEditIntent("sign-in");
    setEditSessionId((current) => current + 1);
    setEditProfileOpen(true);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-ui-sm font-medium text-foreground">Profiles</div>
          <div className="flex items-center gap-1">
            <TooltipWrapper
              label={addProfileDisabledReason}
              side="top"
              sideOffset={6}
              align="start"
            >
              {/* Span between the tooltip and the button because a `disabled`
                  button emits no pointer events for Radix to hover-detect -
                  and the reason it is disabled is exactly what this says. */}
              <span className="inline-flex">
                <Button
                  type="button"
                  size="sm"
                  className="shrink-0"
                  disabled={addProfileDisabled}
                  onClick={onAddProfile}
                >
                  <Plus className="size-3.5" />
                  Add profile
                </Button>
              </span>
            </TooltipWrapper>
            <ProviderProfilesRefreshButton
              providerId={state.providerId}
              profileId={profileCommitId(selectedProfile)}
              usageUpdatedAt={selectedProfile.usageUpdatedAt}
              fetchEligible={profileRateLimitFetchEligible(
                state,
                selectedProfile,
              )}
              maintenanceAvailable={profileStatusRefreshAvailable}
            />
          </div>
        </div>
        <ProfileDropdown
          providerLabel={providerLabel}
          profiles={profiles}
          activeProfileId={selectedProfileId}
          onSelectProfile={onSelectedProfileIdChange}
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
        <div
          data-slot="profile-summary-actions"
          // Wraps because every item except the email is a fixed-width chip:
          // in a single-line row a narrow viewport collapses the email to
          // nothing and then pushes the chips into one another, since none of
          // them can shrink. Wrapping drops the buttons onto their own line
          // instead, keeping every chip whole.
          className="flex min-w-0 flex-wrap items-center justify-end gap-2"
        >
          <ProfileSummary
            key={selectedProfile.profileId}
            profile={selectedProfile}
          />
          {selectedProfile.auth.status === "unauthenticated" ? (
            <TooltipWrapper
              label={canAddProfile ? null : signInUnavailableHint}
              side="top"
              sideOffset={6}
              align="start"
            >
              <span className="inline-flex">
                <Button
                  type="button"
                  size="xs"
                  variant="secondary"
                  className="shrink-0"
                  disabled={!canAddProfile}
                  onClick={openProfileSignIn}
                >
                  <LogIn data-icon="inline-start" />
                  Sign in
                </Button>
              </span>
            </TooltipWrapper>
          ) : null}
          <TooltipWrapper
            label="Change the profile name and accent color, sign in again, or remove this profile."
            side="bottom"
            sideOffset={6}
            align="end"
          >
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={openProfileEditor}
            >
              <Settings2 data-icon="inline-start" />
              Manage profile
            </Button>
          </TooltipWrapper>
        </div>

        <ProfileScopedSectionMessages
          selectedProfile={selectedProfile}
          addProfileDisabled={addProfileDisabled}
          addProfileDisabledReason={addProfileDisabledReason}
          failedAttempt={failedAttempt}
          onAddProfile={onAddProfile}
          onDismissFailedAttempt={onDismissFailedAttempt}
          driftDismissed={driftDismissed}
          onDismissDrift={dismissDrift}
          duplicateLabel={duplicateLabel}
        />

        <EmbeddedProviderRateLimitForProvider
          providerId={state.providerId}
          profileId={profileCommitId(selectedProfile)}
          usageUpdatedAt={selectedProfile.usageUpdatedAt}
          fetchEligible={profileRateLimitFetchEligible(state, selectedProfile)}
        />
      </div>

      <ProfileEditDialog
        key={`${hostId}:${state.providerId}:${selectedProfile.profileId}:${editSessionId}`}
        state={state}
        profile={selectedProfile}
        profiles={profiles}
        canOauth={canAddProfile}
        startInReauth={editIntent === "sign-in"}
        open={editProfileOpen}
        onOpenChange={setEditProfileOpen}
        remainingProfilesAfterRemoval={profiles.filter(
          (candidate) => candidate.profileId !== selectedProfile.profileId,
        )}
        onSelectedProfileIdChange={onSelectedProfileIdChange}
        profileEnablementAvailable={profileEnablementAvailable}
        profileEnablementPending={profileEnablementPending}
        onSetProfileEnabled={onSetProfileEnabled}
      />
    </section>
  );
}

function ProfileSummary({
  profile,
}: {
  readonly profile: ProviderProfile;
}): ReactNode {
  const [emailRevealed, setEmailRevealed] = useState(false);
  const email = profile.identity?.email ?? null;
  let emailText = profile.auth.label ?? "Email unavailable";
  if (email !== null) {
    emailText = emailRevealed ? email : redactEmail(email);
  }
  const tier = profile.identity?.tier;
  const planText =
    tier === null || tier === undefined || tier.length === 0 ? null : tier;

  return (
    <div className="flex min-w-0 flex-auto flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground">
      {/* The email (and its reveal toggle) is the one shrinkable item; the
          badges are whole-or-nothing chips. `flex-auto`, not `flex-1`: the
          wrap threshold is computed from each unit's flex BASIS, and `flex-1`
          zeroes it - a zero-basis email reserves no width during line
          collection, so the fixed chips would stay on the line and still
          paint over the toggle. With its content as its basis the email
          claims its width first, whole chips move down when the line cannot
          hold everything, and the email truncates only once it has a line
          largely to itself. */}
      <div className="flex min-w-0 flex-auto items-center gap-1">
        <TooltipWrapper
          label={emailRevealed ? email : null}
          side="top"
          sideOffset={undefined}
          align="start"
        >
          <span className="min-w-0 truncate">{emailText}</span>
        </TooltipWrapper>
        {email !== null ? (
          <button
            type="button"
            aria-label={
              emailRevealed
                ? `Hide email for ${profileDisplayLabel(profile)}`
                : `Reveal email for ${profileDisplayLabel(profile)}`
            }
            aria-pressed={emailRevealed}
            className="shrink-0 rounded p-0.5 text-current opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={() => setEmailRevealed(!emailRevealed)}
          >
            {emailRevealed ? (
              <EyeOff className="size-3" />
            ) : (
              <Eye className="size-3" />
            )}
          </button>
        ) : null}
      </div>
      <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
        {profileAuthStatusText(profile)}
      </Badge>
      {planText !== null ? (
        <TooltipWrapper
          label={planText}
          side="top"
          sideOffset={undefined}
          align="end"
        >
          <Badge
            variant="outline"
            className="h-5 max-w-[min(28vw,14rem)] shrink-0 px-1.5 text-[10px]"
          >
            <span className="truncate">{planText}</span>
          </Badge>
        </TooltipWrapper>
      ) : null}
    </div>
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
        {profileDisplayLabel(profile)} is now {current}; was {previous}.
      </span>
      <button
        type="button"
        aria-label="Dismiss ambient account change notice"
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
