import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Eye,
  EyeOff,
  LogIn,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { redactEmail } from "@/lib/providers/redact-email";
import { useRemoveProviderProfile } from "@/hooks/providers/use-remove-provider-profile-mutation";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import {
  ProfileDropdown,
  type ProfileDropdownShortcutHint,
} from "@/components/providers/profile-dropdown";
import {
  EmbeddedProviderRateLimitForProvider,
  ProviderProfilesRefreshButton,
} from "./provider-rate-limit-section";
import { ProviderProfileReauthPanel } from "./provider-profile-reauth-panel";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import type { FailedProviderProfileAttempt } from "./add-provider-profile-dialog";
import {
  duplicateProfileLabel,
  orderProfiles,
  profileAuthStatusText,
  profileCommitId,
  profileDisplayLabel,
} from "@/components/providers/provider-profile-model";

type ProviderId = ProviderCliState["providerId"];

const TERMINAL_PROFILE_REMOVE_DISABLED_REASON =
  "This profile uses your default CLI login and cannot be removed.";

const PROFILE_REMOVE_PRESENTATION = {
  ambient: {
    ariaLabel: `Remove profile. ${TERMINAL_PROFILE_REMOVE_DISABLED_REASON}`,
    disabledReason: TERMINAL_PROFILE_REMOVE_DISABLED_REASON,
  },
  managed: {
    ariaLabel: "Remove profile",
    disabledReason: null,
  },
} as const;

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
  readonly hostId: string | null;
  readonly isSelectedHostLocal: boolean;
  readonly canAddProfile: boolean;
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
    startInReauth,
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
  const [editProfileOpen, setEditProfileOpen] = useState(startInReauth);
  const [editSessionId, setEditSessionId] = useState(0);
  const [editIntent, setEditIntent] = useState<"manage" | "sign-in">(
    startInReauth ? "sign-in" : "manage",
  );

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
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={addProfileDisabled}
              title={addProfileDisabledReason}
              onClick={onAddProfile}
            >
              <Plus className="size-3.5" />
              Add profile
            </Button>
            <ProviderProfilesRefreshButton
              providerId={state.providerId}
              profileId={profileCommitId(selectedProfile)}
              usageUpdatedAt={selectedProfile.usageUpdatedAt}
            />
          </div>
        </div>
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
          usagePresentation={null}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ProfileSummary
            key={selectedProfile.profileId}
            profile={selectedProfile}
          />
          {selectedProfile.auth.status === "unauthenticated" ? (
            <Button
              type="button"
              size="xs"
              variant="secondary"
              disabled={!canAddProfile}
              title={
                canAddProfile
                  ? undefined
                  : "Sign in requires a local host with browser sign-in available."
              }
              onClick={openProfileSignIn}
            >
              <LogIn data-icon="inline-start" />
              Sign in
            </Button>
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
              onClick={openProfileEditor}
            >
              <Settings2 data-icon="inline-start" />
              Manage profile
            </Button>
          </TooltipWrapper>
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

        {selectedProfile.kind === "ambient" &&
        selectedProfile.ambientDriftNotice !== null &&
        !driftDismissed ? (
          <AmbientDriftNotice
            profile={selectedProfile}
            onDismiss={dismissDrift}
          />
        ) : null}

        {duplicateLabel !== null ? (
          <ProfileWarning>Same account as {duplicateLabel}</ProfileWarning>
        ) : null}

        <EmbeddedProviderRateLimitForProvider
          providerId={state.providerId}
          profileId={profileCommitId(selectedProfile)}
          usageUpdatedAt={selectedProfile.usageUpdatedAt}
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
        remainingProfilesAfterRemoval={orderedProfiles.filter(
          (candidate) => candidate.profileId !== selectedProfile.profileId,
        )}
        onSelectedProfileIdChange={onSelectedProfileIdChange}
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
    tier === null || tier === undefined || tier.length === 0 ? "No plan" : tier;

  return (
    <div className="grid min-w-[75%] flex-1 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-ui-xs text-muted-foreground">
      <div className="flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate" title={email ?? undefined}>
          {emailText}
        </span>
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
      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
        {profileAuthStatusText(profile)}
      </Badge>
      <Badge
        variant="outline"
        className="h-5 max-w-[min(28vw,14rem)] px-1.5 text-[10px]"
        title={planText}
      >
        <span className="truncate">{planText}</span>
      </Badge>
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

function ProfileEditErrors({
  renameError,
  recolorError,
  removeError,
}: {
  readonly renameError: Error | null;
  readonly recolorError: Error | null;
  readonly removeError: Error | null;
}): ReactNode {
  const editError = renameError ?? recolorError;

  return (
    <>
      {editError !== null ? (
        <p className="text-ui-xs text-destructive">{editError.message}</p>
      ) : null}
      {removeError !== null ? (
        <p className="text-ui-xs text-destructive">{removeError.message}</p>
      ) : null}
    </>
  );
}

function profileEditDialogCopy(
  profile: ProviderProfile,
  startInReauth: boolean,
) {
  if (startInReauth) {
    return {
      title: `Sign in to ${profileDisplayLabel(profile)}`,
      description: "Reconnect this profile without changing its name or color.",
    };
  }
  return {
    title: "Edit profile",
    description: `Update how ${profileDisplayLabel(profile)} appears and which account it uses.`,
  };
}

function ProfileEditDialog({
  state,
  profile,
  profiles,
  canOauth,
  startInReauth,
  open,
  onOpenChange,
  remainingProfilesAfterRemoval,
  onSelectedProfileIdChange,
}: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly canOauth: boolean;
  readonly startInReauth: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The provider's other profiles, ordered - what stays once `profile` is
   *  removed. Lets a successful removal land the section on a profile that
   *  still exists instead of leaving `selectedProfileId` pointed at the one
   *  just deleted. */
  readonly remainingProfilesAfterRemoval: ReadonlyArray<ProviderProfile>;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
}): ReactNode {
  const providerId = state.providerId;
  const removeProfile = useRemoveProviderProfile();
  const renameProfile = useRenameProviderProfile();
  const recolorProfile = useRecolorProviderProfile();
  const [switchingAccount, setSwitchingAccount] = useState(startInReauth);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [label, setLabel] = useState(profile.label);
  const [committedLabel, setCommittedLabel] = useState(profile.label);
  const [accentColor, setAccentColor] =
    useState<ProviderProfileAccentColor | null>(profile.accentColor);
  const [committedAccentColor, setCommittedAccentColor] =
    useState<ProviderProfileAccentColor | null>(profile.accentColor);
  const trimmedLabel = label.trim();
  const savePending = renameProfile.isPending || recolorProfile.isPending;
  const changed =
    trimmedLabel !== committedLabel || accentColor !== committedAccentColor;
  const invalid = trimmedLabel.length === 0;
  const removeProfilePresentation = PROFILE_REMOVE_PRESENTATION[profile.kind];
  const removeProfileDisabledReason = removeProfilePresentation.disabledReason;
  const isTerminalProfile = removeProfileDisabledReason !== null;
  const dialogCopy = profileEditDialogCopy(profile, startInReauth);

  const commitProfile = (onSuccess: () => void): void => {
    if (savePending || invalid) return;
    const recolorIfNeeded = (): void => {
      if (accentColor === null || accentColor === committedAccentColor) {
        onSuccess();
        return;
      }
      recolorProfile.mutate(
        {
          providerId,
          profileId: profile.profileId,
          accentColor,
        },
        {
          onSuccess: () => {
            setCommittedAccentColor(accentColor);
            onSuccess();
          },
        },
      );
    };
    if (trimmedLabel !== committedLabel) {
      renameProfile.mutate(
        {
          providerId,
          profileId: profile.profileId,
          label: trimmedLabel,
        },
        {
          onSuccess: () => {
            setCommittedLabel(trimmedLabel);
            recolorIfNeeded();
          },
        },
      );
      return;
    }
    recolorIfNeeded();
  };

  const closeEditor = (): void => {
    onOpenChange(false);
  };

  const switchAccount = (): void => {
    setSwitchingAccount(true);
  };

  const requestRemove = (): void => {
    onOpenChange(false);
    setConfirmRemoveOpen(true);
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && (savePending || switchingAccount)) return;
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent
          className="max-h-[min(85dvh,40rem)] w-[min(92vw,30rem)] gap-0 overflow-y-auto p-0 sm:max-w-none"
          showCloseButton={!switchingAccount}
        >
          <DialogHeader className="gap-1.5 px-5 pt-5 pr-12 pb-4">
            <DialogTitle className="text-ui font-semibold leading-snug">
              {dialogCopy.title}
            </DialogTitle>
            <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground">
              {dialogCopy.description}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-5 px-5 pb-5">
            <ProviderProfileCard
              key={profile.profileId}
              profile={profile}
              profiles={profiles}
              label={label}
              onLabelChange={setLabel}
              selectedColor={accentColor}
              onSelectColor={setAccentColor}
              disabled={savePending || switchingAccount}
            />

            {switchingAccount ? (
              <ProviderProfileReauthPanel
                state={state}
                profile={profile}
                onCancel={() => setSwitchingAccount(false)}
                onDone={() => setSwitchingAccount(false)}
              />
            ) : (
              <button
                type="button"
                aria-label="Switch account"
                className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canOauth || savePending || invalid}
                title={
                  canOauth
                    ? undefined
                    : "Switch account requires a local host with browser sign-in available."
                }
                onClick={switchAccount}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground ring-1 ring-border/60 transition-colors group-hover:text-foreground">
                  <RefreshCw className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-ui-sm font-medium text-foreground">
                    Switch account
                  </span>
                  <span className="block text-ui-xs text-muted-foreground">
                    Sign in with a different account for this profile.
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </button>
            )}

            <ProfileEditErrors
              renameError={renameProfile.error}
              recolorError={recolorProfile.error}
              removeError={removeProfile.error}
            />
          </div>

          <DialogFooter
            className={
              switchingAccount
                ? "hidden"
                : "mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-muted/20 px-5 py-3"
            }
          >
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <TooltipWrapper
                label={removeProfileDisabledReason}
                side="top"
                sideOffset={6}
                align="start"
              >
                <span
                  className="inline-flex"
                  title={removeProfileDisabledReason ?? undefined}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={removeProfilePresentation.ariaLabel}
                    disabled={
                      isTerminalProfile ||
                      removeProfile.isPending ||
                      savePending
                    }
                    onClick={requestRemove}
                    className="text-ui-sm text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                    Remove profile
                  </Button>
                </span>
              </TooltipWrapper>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={savePending}
                  onClick={closeEditor}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={savePending || invalid || !changed}
                  onClick={() => commitProfile(closeEditor)}
                >
                  {savePending ? <MutedAgentSpinner /> : null}
                  Save changes
                </Button>
              </div>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDestructiveDialog
        open={confirmRemoveOpen}
        onOpenChange={setConfirmRemoveOpen}
        title={`Remove ${profileDisplayLabel(profile)}?`}
        description={`Agents that ran on ${profileDisplayLabel(profile)} will show it as removed. Running sessions on this profile must be stopped first.`}
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
    </>
  );
}
