import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ChevronRight, RefreshCw, Trash2 } from "lucide-react";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderCliState,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import { CopyTextButton } from "@/components/copy-text-button";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import {
  profileCommitId,
  profileDisplayLabel,
  profileEnablementTooltipText,
  profileEligibilityToggleDisabledReason,
} from "@/components/providers/provider-profile-model";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useRecolorProviderProfile } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useRemoveProviderProfile } from "@/hooks/providers/use-remove-provider-profile-mutation";
import { useRenameProviderProfile } from "@/hooks/providers/use-rename-provider-profile-mutation";
import { redactEmail } from "@/lib/providers/redact-email";
import { ProviderProfileReauthPanel } from "./provider-profile-reauth-panel";

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

function ProfileEditErrors(props: {
  readonly renameError: Error | null;
  readonly recolorError: Error | null;
  readonly removeError: Error | null;
}): ReactNode {
  const editError = props.renameError ?? props.recolorError;
  return (
    <>
      {editError !== null ? (
        <p className="text-ui-xs text-destructive">{editError.message}</p>
      ) : null}
      {props.removeError !== null ? (
        <p className="text-ui-xs text-destructive">
          {props.removeError.message}
        </p>
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

function signedInMessage(profile: ProviderProfile): string {
  const email = profile.identity?.email ?? null;
  if (email !== null) return `Signed in as ${redactEmail(email)}`;
  return `Signed in to ${profileDisplayLabel(profile)}`;
}

function ProfileEligibilityEditor(props: {
  readonly profile: ProviderProfile;
  readonly available: boolean;
  readonly pending: boolean;
  readonly disabledReason: string | null;
  readonly onSetEnabled: (enabled: boolean) => void;
}): ReactNode {
  if (!props.available) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-foreground/3 p-3">
      <div className="min-w-0">
        <div className="text-ui-sm font-medium text-foreground">
          Allow agents to use this profile
        </div>
        <div className="text-ui-xs text-muted-foreground">
          {props.profile.enabled ? "Enabled" : "Disabled"}. Disabled profiles
          stay visible but cannot start new work.
        </div>
      </div>
      <TooltipWrapper
        label={profileEnablementTooltipText(
          props.profile.enabled,
          props.disabledReason,
        )}
        side="left"
        sideOffset={6}
        align={undefined}
      >
        <span className="inline-flex shrink-0">
          <Switch
            aria-label={`Allow agents to use ${profileDisplayLabel(props.profile)}`}
            checked={props.profile.enabled}
            disabled={props.pending}
            aria-disabled={props.disabledReason !== null || undefined}
            onCheckedChange={(enabled) => {
              if (props.disabledReason !== null) return;
              props.onSetEnabled(enabled);
            }}
          />
        </span>
      </TooltipWrapper>
    </div>
  );
}

function ProfileLaunchCommandBlock(props: {
  readonly providerId: ProviderId;
  readonly launchCommand: ProviderProfile["launchCommand"];
}): ReactNode {
  const launchCommand = props.launchCommand ?? null;
  if (launchCommand === null) return null;
  const providerLabel = PROVIDER_DISPLAY_NAMES[props.providerId];

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="space-y-0.5">
        <div className="text-ui-sm font-medium text-foreground">
          Open from terminal
        </div>
        <p className="text-pretty text-ui-xs leading-relaxed text-muted-foreground">
          Run this command on this host to open {providerLabel} with this
          profile.
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border/60 bg-foreground/5 px-2 py-1.5">
        <span className="shrink-0 font-mono text-code-xs text-muted-foreground">
          {launchCommand.shell === "powershell" ? "PowerShell" : "sh"}
        </span>
        <code
          aria-label={`${providerLabel} profile launch command`}
          className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-code-xs text-foreground"
        >
          {launchCommand.command}
        </code>
        <CopyTextButton
          value={launchCommand.command}
          label={null}
          ariaLabel={`Copy ${providerLabel} profile launch command`}
          disabled={false}
        />
      </div>
    </div>
  );
}

function ProfileEditAccountSection(props: {
  readonly providerId: ProviderId;
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly switchingAccount: boolean;
  readonly startInReauth: boolean;
  readonly canOauth: boolean;
  readonly savePending: boolean;
  readonly invalid: boolean;
  readonly onStartSwitchingAccount: () => void;
  readonly onCancelSwitchingAccount: () => void;
  readonly onCloseAfterSignIn: () => void;
  readonly onFinishSignIn: (profile: ProviderProfile) => void;
}): ReactNode {
  if (props.switchingAccount) {
    return (
      <ProviderProfileReauthPanel
        state={props.state}
        profile={props.profile}
        onSameAccountReconnected={
          props.startInReauth ? props.onFinishSignIn : null
        }
        onCancel={props.onCancelSwitchingAccount}
        onDone={
          props.startInReauth
            ? props.onCloseAfterSignIn
            : props.onCancelSwitchingAccount
        }
      />
    );
  }

  return (
    <>
      <ProfileLaunchCommandBlock
        providerId={props.providerId}
        launchCommand={props.profile.launchCommand}
      />
      <TooltipWrapper
        label={
          props.canOauth
            ? null
            : "Switch account requires a local host with browser sign-in available."
        }
        side="top"
        sideOffset={6}
        align={undefined}
      >
        <span className="flex w-full">
          <button
            type="button"
            aria-label="Switch account"
            className="group flex w-full items-center gap-3 rounded-lg border border-border/60 bg-foreground/3 p-3 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!props.canOauth || props.savePending || props.invalid}
            onClick={props.onStartSwitchingAccount}
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
        </span>
      </TooltipWrapper>
    </>
  );
}

export function ProfileEditDialog(props: {
  readonly state: ProviderCliState;
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly canOauth: boolean;
  readonly startInReauth: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly remainingProfilesAfterRemoval: ReadonlyArray<ProviderProfile>;
  readonly onSelectedProfileIdChange: (profileId: string | null) => void;
  readonly profileEnablementAvailable: boolean;
  readonly profileEnablementPending: (profileId: string | null) => boolean;
  readonly onSetProfileEnabled: (
    profileId: string | null,
    enabled: boolean,
  ) => void;
}): ReactNode {
  const providerId = props.state.providerId;
  const removeProfile = useRemoveProviderProfile();
  const renameProfile = useRenameProviderProfile();
  const recolorProfile = useRecolorProviderProfile();
  const [switchingAccountOverride, setSwitchingAccount] = useState<
    boolean | null
  >(null);
  const switchingAccount = switchingAccountOverride ?? props.startInReauth;
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const [labelOverride, setLabel] = useState<string | null>(null);
  const [committedLabelOverride, setCommittedLabel] = useState<string | null>(
    null,
  );
  const label = labelOverride ?? props.profile.label;
  const committedLabel = committedLabelOverride ?? props.profile.label;
  const [accentColorOverride, setAccentColor] = useState<
    ProviderProfileAccentColor | null | undefined
  >(undefined);
  const [committedAccentColorOverride, setCommittedAccentColor] = useState<
    ProviderProfileAccentColor | null | undefined
  >(undefined);
  const accentColor =
    accentColorOverride === undefined
      ? props.profile.accentColor
      : accentColorOverride;
  const committedAccentColor =
    committedAccentColorOverride === undefined
      ? props.profile.accentColor
      : committedAccentColorOverride;
  const trimmedLabel = label.trim();
  const savePending = renameProfile.isPending || recolorProfile.isPending;
  const changed =
    trimmedLabel !== committedLabel || accentColor !== committedAccentColor;
  const invalid = trimmedLabel.length === 0;
  const removePresentation = PROFILE_REMOVE_PRESENTATION[props.profile.kind];
  const removeDisabledReason = removePresentation.disabledReason;
  const dialogCopy = profileEditDialogCopy(props.profile, props.startInReauth);
  const eligibilityDisabledReason = profileEligibilityToggleDisabledReason(
    props.state.enabled,
    props.profile,
    props.profiles,
  );
  const enablementPending = props.profileEnablementPending(
    profileCommitId(props.profile),
  );

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
          profileId: props.profile.profileId,
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
          profileId: props.profile.profileId,
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

  const closeAfterSignIn = (): void => props.onOpenChange(false);
  const finishSignIn = (signedIn: ProviderProfile): void => {
    closeAfterSignIn();
    toast.success(signedInMessage(signedIn));
  };
  const requestRemove = (): void => {
    props.onOpenChange(false);
    setConfirmRemoveOpen(true);
  };

  return (
    <>
      <Dialog
        open={props.open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && (savePending || switchingAccount)) return;
          props.onOpenChange(nextOpen);
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
              key={props.profile.profileId}
              profile={props.profile}
              profiles={props.profiles}
              label={label}
              onLabelChange={setLabel}
              selectedColor={accentColor}
              onSelectColor={setAccentColor}
              disabled={savePending || switchingAccount}
            />

            <ProfileEligibilityEditor
              profile={props.profile}
              available={props.profileEnablementAvailable}
              pending={enablementPending}
              disabledReason={eligibilityDisabledReason}
              onSetEnabled={(enabled) =>
                props.onSetProfileEnabled(
                  profileCommitId(props.profile),
                  enabled,
                )
              }
            />

            <ProfileEditAccountSection
              providerId={providerId}
              state={props.state}
              profile={props.profile}
              switchingAccount={switchingAccount}
              startInReauth={props.startInReauth}
              canOauth={props.canOauth}
              savePending={savePending}
              invalid={invalid}
              onStartSwitchingAccount={() => setSwitchingAccount(true)}
              onCancelSwitchingAccount={() => setSwitchingAccount(false)}
              onCloseAfterSignIn={closeAfterSignIn}
              onFinishSignIn={finishSignIn}
            />

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
                : "mx-0 mb-0 rounded-b-xl border-t border-border/70 bg-foreground/3 px-5 py-3"
            }
          >
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <TooltipWrapper
                label={removeDisabledReason}
                side="top"
                sideOffset={6}
                align="start"
              >
                <span className="inline-flex">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={removePresentation.ariaLabel}
                    disabled={
                      removeDisabledReason !== null ||
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
                  onClick={() => props.onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={savePending || invalid || !changed}
                  onClick={() => commitProfile(() => props.onOpenChange(false))}
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
        title={`Remove ${profileDisplayLabel(props.profile)}?`}
        description={`Agents that ran on ${profileDisplayLabel(props.profile)} will show it as removed. Running sessions on this profile must be stopped first.`}
        cascadeSummary={null}
        actionLabel="Remove"
        isPending={removeProfile.isPending}
        onConfirm={() =>
          removeProfile.mutate(
            { providerId, profileId: props.profile.profileId },
            {
              onSuccess: () => {
                setConfirmRemoveOpen(false);
                const nextProfile = props.remainingProfilesAfterRemoval.at(0);
                props.onSelectedProfileIdChange(
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
