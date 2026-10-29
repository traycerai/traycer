import { useState, type ReactNode } from "react";

import { useIsMutatingOf } from "@/hooks/use-mutation-state-of";
import { AppliedProviderItemDetails } from "@/components/settings/environment/applied-provider-item-details";
import { providerIdToGuiHarnessId } from "@/lib/provider-ordering";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  LogIn,
  Plus,
  Settings2,
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
  providerHostBlockLabel,
  providerSignInUnavailableReason,
} from "@/components/providers/provider-signin-availability";
import { cn } from "@/lib/utils";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useRefreshProviders } from "@/hooks/providers/use-refresh-providers";
import { providersMutationKeys } from "@/lib/query-keys";
import { ProviderOnHostOnlyLine } from "./provider-on-host-only-line";
import { EmbeddedProviderRateLimitForProvider } from "./provider-rate-limit-section";
import { ProfileEditDialog } from "./provider-profile-edit-dialog";
import { ProfileSyncEntryButton } from "./profile-sync/profile-sync-entry-button";
import { profileSyncWireProvider } from "@/lib/profile-sync/profile-sync-presentation";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";
import {
  isProviderAmbientAuthenticated,
  isProviderAmbientSignedOut,
} from "@/lib/providers/provider-ambient-auth";
import { ambientLoginConfigured } from "./provider-rail-state-word";
import { usePersonalHostName } from "@/components/settings/personal/personal-page-context";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";
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

// Stable module-level reference (not a fresh closure per render) - Settings
// has no picker leader scope, so every row opts out of the shortcut hint.
function noProfileShortcutHint(): ProfileDropdownShortcutHint | null {
  return null;
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
  /** The selected host is this machine - the reauth waiting step auto-opens
   *  only when it is not, or when the child printed a device code. */
  readonly isSelectedHostLocal: boolean;
  readonly canAddProfile: boolean;
  /**
   * Why no credential may go to this host (a sandbox), or `null`. Already
   * folded into `canAddProfile`; here it is the reason the sign-in controls
   * show, ahead of any CLI reason.
   */
  readonly credentialRefusal: string | null;
  readonly onOpenCliSettings: () => void;
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
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
}

/**
 * The terminal login's row label: the tool's own sign-in on the host this
 * page reads, which Traycer neither made nor carries anywhere else.
 */
function ownLoginLabel(providerLabel: string, hostName: string | null): string {
  return `${providerLabel}'s own login on ${hostName ?? "this computer"}`;
}

/**
 * What holds this section's controls, read once for all of them.
 *
 * `signInUnavailableHint` is why a sign-in (Add profile, Sign in, Switch
 * account, Retry) cannot start, or null. `cliSetupNeeded` says the reason is
 * a CLI that is missing, not the selected one, still being looked for, or
 * still downloading, which the CLI & Args tab is where to fix; a provider
 * that is off is turned on by the switch in the header instead, so that
 * reason does not link.
 *
 * `managementHeldReason` holds every profile control while the provider is
 * off, whether or not the host could run its CLI: the sign-in controls fold
 * it into `canAddProfile`, and the ones that need no CLI (Manage profile,
 * usage) hold on this alone.
 */
function profileControlsHold(
  state: ProviderCliState,
  isSelectedHostLocal: boolean,
  credentialRefusal: string | null,
): {
  readonly signInUnavailableHint: string | null;
  readonly cliSetupNeeded: boolean;
  readonly managementHeldReason: string | null;
} {
  const providerLabel = PROVIDER_DISPLAY_NAMES[state.providerId];
  const reason = providerSignInUnavailableReason(
    state,
    isSelectedHostLocal,
    "sign-in",
  );
  let signInUnavailableHint: string | null = null;
  if (credentialRefusal !== null) {
    signInUnavailableHint = credentialRefusal;
  } else if (reason?.kind === "host") {
    signInUnavailableHint =
      reason.block.kind === "pack"
        ? "Sign-in is unavailable until CLI setup is complete."
        : providerHostBlockLabel(reason.block, providerLabel);
  } else if (reason !== null) {
    signInUnavailableHint = reason.hint;
  }
  return {
    signInUnavailableHint,
    cliSetupNeeded:
      credentialRefusal === null &&
      reason?.kind === "host" &&
      reason.block.kind !== "disabled",
    managementHeldReason: state.enabled
      ? null
      : providerHostBlockLabel({ kind: "disabled" }, providerLabel),
  };
}

function ProfileScopedSectionMessages(props: {
  readonly addProfileDisabled: boolean;
  readonly addProfileDisabledReason: string | null;
  readonly onOpenCliSettings: (() => void) | null;
  /** Retry starts the same sign-in Add profile does, so it is held with it. */
  readonly retryDisabled: boolean;
  readonly failedAttempt: FailedProviderProfileAttempt | null;
  readonly onAddProfile: () => void;
  readonly onDismissFailedAttempt: () => void;
  readonly duplicateLabel: string | null;
}): ReactNode {
  return (
    <>
      {props.addProfileDisabled ? (
        <p className="text-ui-xs text-muted-foreground">
          {props.addProfileDisabledReason}
          {props.onOpenCliSettings !== null ? (
            <>
              {" "}
              <Button
                type="button"
                variant="link"
                size="inline-xs"
                onClick={props.onOpenCliSettings}
              >
                CLI &amp; Args
              </Button>
            </>
          ) : null}
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
              disabled={props.retryDisabled}
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
 * and actions - is scoped to `selectedProfileId`. With zero profiles there
 * is no section; the caller keeps the plain unscoped
 * `ProviderRateLimitForProvider` mounted for that case.
 *
 * The terminal login is a read-only row (design, Profiles & Limits): named as
 * the tool's own login on this host, with one verb that starts a Settings
 * sign-in - a new profile that follows you - and leaves that login untouched.
 *
 * The card's one verb is `Add a profile`: Personal carries every profile it
 * holds to each computer running it. The page header's Refresh re-probes every
 * profile's sign-in, and usage re-reads on open and after each turn, so the
 * card carries no refresh of its own.
 *
 * A build without environments (`unreleased-features.ts`) has no Personal to
 * carry profiles, so the card reads as it did before them: the terminal
 * login is a profile row like the others, `Add profile` beside `Sync
 * profiles…`, which copies profiles to the person's other computers host to
 * host, and a provider with no profile keeps that entry.
 */
export function ProviderProfileScopedSection(
  props: ProviderProfileScopedSectionProps,
): ReactNode {
  const {
    state,
    hostId,
    isSelectedHostLocal,
    canAddProfile,
    credentialRefusal,
    onOpenCliSettings,
    startInReauth,
    failedAttempt,
    onAddProfile,
    onDismissFailedAttempt,
    selectedProfileId,
    onSelectedProfileIdChange,
    profileEnablementAvailable,
    profileEnablementPending,
    onSetProfileEnabled,
  } = props;
  const profiles = state.profiles;
  const pick = useEnvironmentPick();
  const personalHostName = usePersonalHostName();
  // A Local row reads its own computer; Personal names the window's host.
  const hostName = pick.kind === "local" ? pick.hostName : personalHostName;
  const [editProfileOpen, setEditProfileOpen] = useState(startInReauth);
  const [editSessionId, setEditSessionId] = useState(0);
  const [editIntent, setEditIntent] = useState<"manage" | "sign-in">(() =>
    startInReauth ? "sign-in" : "manage",
  );

  if (profiles.length === 0) {
    return UNRELEASED_FEATURES_ENABLED ? null : (
      <EmptyProviderProfiles state={state} hostId={hostId} />
    );
  }

  const selectedProfile =
    profiles.find(
      (candidate) => profileCommitId(candidate) === selectedProfileId,
    ) ?? profiles[0];
  const providerLabel = PROVIDER_DISPLAY_NAMES[state.providerId];
  const addProfileDisabled = !canAddProfile;
  const { signInUnavailableHint, cliSetupNeeded, managementHeldReason } =
    profileControlsHold(state, isSelectedHostLocal, credentialRefusal);
  // `TooltipWrapper` degrades to a passthrough Slot for both `null` and
  // `undefined` labels; `null` here is just the plainer of the two spellings.
  const addProfileDisabledReason = addProfileDisabled
    ? signInUnavailableHint
    : null;
  const duplicateLabel = duplicateProfileLabel(selectedProfile, profiles);
  const ownLogin = ownLoginLabel(providerLabel, hostName);
  // The dropdown names the terminal login the way its row does; without
  // environments the row is a profile row and keeps its own label and badge.
  const labelledProfiles = UNRELEASED_FEATURES_ENABLED
    ? profiles.map((profile) =>
        profile.kind === "ambient" ? { ...profile, label: ownLogin } : profile,
      )
    : profiles;

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
          <div className="flex flex-wrap items-center gap-1">
            {UNRELEASED_FEATURES_ENABLED ? null : (
              <ProfileSyncEntryButton
                hostId={hostId}
                providerId={state.providerId}
              />
            )}
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
                  {UNRELEASED_FEATURES_ENABLED
                    ? "Add a profile"
                    : "Add profile"}
                </Button>
              </span>
            </TooltipWrapper>
          </div>
        </div>
        <ProfileDropdown
          providerLabel={providerLabel}
          profiles={labelledProfiles}
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
                      providerLabel,
                      profile,
                      profiles,
                    ),
                  onSetEnabled: onSetProfileEnabled,
                }
              : null
          }
          admissionByProfileId={null}
          showTerminalBadge={!UNRELEASED_FEATURES_ENABLED}
        />
        {UNRELEASED_FEATURES_ENABLED ? (
          <ProviderOnHostOnlyLine
            hostId={hostId}
            providerId={state.providerId}
            profileId={selectedProfile.profileId}
          />
        ) : null}
        <SelectedProfileRow
          state={state}
          hostName={hostName}
          profile={selectedProfile}
          addProfileDisabled={addProfileDisabled}
          addProfileDisabledReason={addProfileDisabledReason}
          onAddProfile={onAddProfile}
          canAddProfile={canAddProfile}
          signInUnavailableHint={signInUnavailableHint}
          managementHeldReason={managementHeldReason}
          onSignIn={openProfileSignIn}
          onManage={openProfileEditor}
        />

        <ProfileScopedSectionMessages
          addProfileDisabled={addProfileDisabled}
          addProfileDisabledReason={addProfileDisabledReason}
          onOpenCliSettings={cliSetupNeeded ? onOpenCliSettings : null}
          retryDisabled={addProfileDisabled}
          failedAttempt={failedAttempt}
          onAddProfile={onAddProfile}
          onDismissFailedAttempt={onDismissFailedAttempt}
          duplicateLabel={duplicateLabel}
        />

        <div
          className={cn(
            "flex flex-col",
            managementHeldReason !== null && "pointer-events-none opacity-50",
          )}
          {...(managementHeldReason !== null ? { inert: true } : {})}
        >
          <EmbeddedProviderRateLimitForProvider
            providerId={state.providerId}
            profileId={profileCommitId(selectedProfile)}
            usageUpdatedAt={selectedProfile.usageUpdatedAt}
            fetchEligible={profileRateLimitFetchEligible(
              state,
              selectedProfile,
            )}
          />
        </div>
      </div>

      <ProfileEditDialog
        key={`${hostId}:${state.providerId}:${selectedProfile.profileId}:${editSessionId}`}
        state={state}
        profile={selectedProfile}
        profiles={profiles}
        canOauth={canAddProfile}
        oauthUnavailableHint={signInUnavailableHint}
        startInReauth={editIntent === "sign-in"}
        isLocalHost={isSelectedHostLocal}
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

/**
 * The selected profile's row under the dropdown: the terminal login's own
 * row with environments, else the profile's summary, its sign-in when it is
 * signed out, and `Manage profile`.
 */
function SelectedProfileRow(props: {
  readonly state: ProviderCliState;
  readonly hostName: string | null;
  readonly profile: ProviderProfile;
  readonly addProfileDisabled: boolean;
  readonly addProfileDisabledReason: string | null;
  readonly onAddProfile: () => void;
  readonly canAddProfile: boolean;
  readonly signInUnavailableHint: string | null;
  readonly managementHeldReason: string | null;
  readonly onSignIn: () => void;
  readonly onManage: () => void;
}): ReactNode {
  const { profile, managementHeldReason } = props;
  if (profile.kind === "ambient" && UNRELEASED_FEATURES_ENABLED) {
    return (
      <OwnLoginSummary
        state={props.state}
        hostName={props.hostName}
        addProfileDisabled={props.addProfileDisabled}
        addProfileDisabledReason={props.addProfileDisabledReason}
        onAddProfile={props.onAddProfile}
      />
    );
  }
  return (
    <div
      data-slot="profile-summary-actions"
      // Wraps because every item except the email is a fixed-width chip:
      // in a single-line row a narrow viewport collapses the email to
      // nothing and then pushes the chips into one another, since none of
      // them can shrink. Wrapping drops the buttons onto their own line
      // instead, keeping every chip whole.
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
    >
      {UNRELEASED_FEATURES_ENABLED ? (
        <AppliedProviderItemDetails
          kind="managed_profile"
          itemKey={`${providerIdToGuiHarnessId(props.state.providerId)}:${profile.profileId}`}
          title={profile.label}
        />
      ) : null}
      <ProfileSummary key={profile.profileId} profile={profile} />
      {profile.auth.status === "unauthenticated" ? (
        <TooltipWrapper
          label={props.canAddProfile ? null : props.signInUnavailableHint}
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
              disabled={!props.canAddProfile}
              onClick={props.onSignIn}
            >
              <LogIn data-icon="inline-start" />
              Sign in
            </Button>
          </span>
        </TooltipWrapper>
      ) : null}
      <TooltipWrapper
        label={
          managementHeldReason ??
          "Change the profile name and accent color, sign in again, or remove this profile."
        }
        side="bottom"
        sideOffset={6}
        align="end"
      >
        {/* Span for the same reason as Add a profile above: a disabled
            button emits no pointer events for the tooltip to see. */}
        <span className="inline-flex">
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={managementHeldReason !== null}
            onClick={props.onManage}
          >
            <Settings2 data-icon="inline-start" />
            Manage profile
          </Button>
        </span>
      </TooltipWrapper>
    </div>
  );
}

/**
 * A provider with no profile on this computer, in a build without
 * environments: the card keeps the `Sync profiles…` entry, so profiles on the
 * person's other computers are still reachable from here.
 */
function EmptyProviderProfiles(props: {
  readonly state: ProviderCliState;
  readonly hostId: string | null;
}): ReactNode {
  if (
    props.hostId === null ||
    profileSyncWireProvider(props.state.providerId) === null
  )
    return null;
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-medium text-foreground">Profiles</div>
        {/* No gate needed: the caller above only reaches this component when
            UNRELEASED_FEATURES_ENABLED is already false, so a second check
            of that same build constant here could never take its other
            branch. */}
        <ProfileSyncEntryButton
          hostId={props.hostId}
          providerId={props.state.providerId}
        />
      </div>
      <p className="text-ui-xs text-muted-foreground">
        No profiles on this device.
      </p>
    </section>
  );
}

/**
 * The terminal login's reconciled read, the same two sources the rail word
 * reads (`provider-rail-state-word.ts`) rather than the ambient profile
 * row's own status alone: that row can lag a probe-less `unauthenticated`
 * stamped at the top level, and reading only the row showed "couldn't be
 * checked" for a login that was definitively absent.
 */
type AmbientLoginReadState = "signed-in" | "signed-out" | "unchecked";

function ambientLoginReadState(state: ProviderCliState): AmbientLoginReadState {
  if (isProviderAmbientSignedOut(state)) return "signed-out";
  if (isProviderAmbientAuthenticated(state) || ambientLoginConfigured(state)) {
    return "signed-in";
  }
  return "unchecked";
}

/**
 * The terminal login's row under the dropdown that names it: where it works
 * and whether it is signed in, with one verb. `Sign in to use everywhere`
 * opens the same sign-in `Add a profile` does, so the tool's own login is
 * never touched from here.
 *
 * No login found and a failed check read differently: the first names no
 * login to manage at all (`isn't signed in`, with a plain `Sign in`), the
 * second names the read itself as the problem (`Couldn't check …`, with the
 * refresh probe as its own Retry) - conflating them is what let a
 * definitively signed-out login read as merely unchecked.
 */
function OwnLoginSummary(props: {
  readonly state: ProviderCliState;
  readonly hostName: string | null;
  readonly addProfileDisabled: boolean;
  readonly addProfileDisabledReason: string | null;
  readonly onAddProfile: () => void;
}): ReactNode {
  const refreshProviders = useRefreshProviders();
  const refreshing =
    useIsMutatingOf({ mutationKey: providersMutationKeys.refresh() }) > 0;
  const providerLabel = PROVIDER_DISPLAY_NAMES[props.state.providerId];
  const hostName = props.hostName ?? "this computer";
  const readState = ambientLoginReadState(props.state);

  if (readState === "signed-out") {
    return (
      <div
        data-slot="profile-summary-actions"
        className="flex min-w-0 flex-wrap items-center justify-between gap-2"
      >
        <span className="min-w-0 text-ui-xs text-muted-foreground">
          {providerLabel} isn&apos;t signed in on {hostName}
        </span>
        <TooltipWrapper
          label={props.addProfileDisabledReason}
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
              disabled={props.addProfileDisabled}
              onClick={props.onAddProfile}
            >
              <LogIn data-icon="inline-start" />
              Sign in
            </Button>
          </span>
        </TooltipWrapper>
      </div>
    );
  }

  if (readState === "unchecked") {
    return (
      <div
        data-slot="profile-summary-actions"
        className="flex min-w-0 flex-wrap items-center gap-1 text-ui-xs text-muted-foreground"
      >
        <span className="min-w-0">
          Couldn&apos;t check {providerLabel}&apos;s login on {hostName}.
        </span>
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          disabled={refreshing}
          onClick={() => void refreshProviders()}
        >
          Retry
          {refreshing ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
            />
          ) : null}
        </Button>
      </div>
    );
  }

  return (
    <div
      data-slot="profile-summary-actions"
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
    >
      <div className="flex min-w-0 flex-auto flex-wrap items-center gap-x-2 gap-y-1 text-ui-xs text-muted-foreground">
        <span className="min-w-0">works on this computer only</span>
        <Badge variant="outline" className="h-5 shrink-0" size="xs">
          Signed in
        </Badge>
      </div>
      <TooltipWrapper
        label={props.addProfileDisabledReason}
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
            disabled={props.addProfileDisabled}
            onClick={props.onAddProfile}
          >
            <LogIn data-icon="inline-start" />
            Sign in to use everywhere
          </Button>
        </span>
      </TooltipWrapper>
    </div>
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
      <Badge variant="outline" className="h-5 shrink-0" size="xs">
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
            className="h-5 max-w-[min(28vw,14rem)] shrink-0"
            size="xs"
          >
            <span className="truncate">{planText}</span>
          </Badge>
        </TooltipWrapper>
      ) : null}
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
