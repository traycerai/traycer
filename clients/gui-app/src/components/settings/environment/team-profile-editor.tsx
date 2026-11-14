import { useState, type ReactNode } from "react";
import type {
  ProviderId,
  ProviderProfile,
  ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import {
  profileDisplayLabel,
  profileOtherNames,
} from "@/components/providers/provider-profile-model";
import { ProfileEditDialogPresentation } from "@/components/settings/panels/profile-edit-dialog-presentation";
import { ProfileOtherNamesControl } from "@/components/settings/panels/provider-profile-other-names";
import { SWITCH_ACCOUNT_TEXT } from "@/components/providers/switch-account-move-dialog";
import { Button } from "@/components/ui/button";
import { ProfilePersonActionConfirmation } from "@/components/settings/panels/profile-person-action-confirmation";
import { profilePersonActionLabel } from "@/components/settings/panels/profile-person-action-copy";
import { useTeamProfileActions } from "@/hooks/environment/team/use-team-profile-actions";
import { useTeamProfileColor } from "@/hooks/environment/team/use-team-profile-color";
import { useConfigurationSource } from "./configuration-source";
import { useTeamProviderRecords } from "./team-provider-records";
import { TeamProfileApiKeyForm } from "./team-profile-api-key-form";
import { usePickedTeamLabel } from "./team-pick-label";

const NO_READ = async (): Promise<void> => {};

export function TeamProfileEditor(props: {
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly onClose: () => void;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
  readonly onSignIn: () => void;
  readonly onSwitch: () => void;
}): ReactNode {
  const source = useConfigurationSource();
  const records = useTeamProviderRecords();
  const actions = useTeamProfileActions(records?.reread ?? NO_READ);
  const colorWrite = useTeamProfileColor(props.onOutcome);
  const [labelOverride, setLabel] = useState<string | null>(null);
  const [colorOverride, setColor] = useState<ProviderProfileAccentColor | null>(
    null,
  );
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const teamName = usePickedTeamLabel(
    source.kind === "pool" ? source.environmentId : "",
  );
  if (source.kind !== "pool" || records === null) return null;
  const environmentId = source.environmentId;
  const { label, color, changed, invalid } = teamProfileEdits(
    props.profile,
    labelOverride,
    colorOverride,
  );
  const busy =
    actions.rename.isPending ||
    actions.remove.isPending ||
    actions.signOut.isPending ||
    colorWrite.pending;
  const request = {
    environmentId,
    providerId: props.providerId,
    profileId: props.profile.profileId,
  };
  const save = async (): Promise<void> => {
    if (busy || invalid || !changed) return;
    try {
      if (label.trim() !== props.profile.label)
        await actions.rename.mutateAsync({ ...request, label: label.trim() });
      if (
        colorOverride !== null &&
        colorOverride !== props.profile.accentColor
      ) {
        const saved = await colorWrite.save(
          environmentId,
          props.providerId,
          props.profile.profileId,
          colorOverride,
        );
        if (!saved) return;
      }
      props.onClose();
    } catch {
      // The mutation's existing seam presents the refusal.
    }
  };
  return (
    <>
      <ProfileEditDialogPresentation
        profile={props.profile}
        profiles={props.profiles}
        title="Edit profile"
        description={`Update how ${profileDisplayLabel(props.profile)} appears and which account it uses.`}
        open={!confirmRemove && !confirmSignOut}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        switchingAccount={false}
        signInSettled={false}
        label={label}
        onLabelChange={setLabel}
        accentColor={color}
        onSelectColor={setColor}
        savePending={busy}
        changed={changed}
        invalid={invalid}
        onSave={() => void save()}
        footerAction={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmSignOut(true)}
          >
            {profilePersonActionLabel("sign-out", "record")}
          </Button>
        }
        removePending={actions.remove.isPending}
        removeDisabledReason={null}
        removeAriaLabel="Remove profile"
        onRequestRemove={() => setConfirmRemove(true)}
        confirmRemoveOpen={confirmRemove}
        onConfirmRemoveOpenChange={(open) => {
          setConfirmRemove(open);
        }}
        removeConfirmation={
          <ProfilePersonActionConfirmation
            action="remove"
            scope="record"
            profileName={profileDisplayLabel(props.profile)}
            environmentName={teamName}
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            isPending={actions.remove.isPending}
            blockedReason={null}
            onConfirm={() =>
              actions.remove.mutate(request, { onSuccess: props.onClose })
            }
          />
        }
        removeDescription=""
        onConfirmRemove={() =>
          actions.remove.mutate(request, { onSuccess: props.onClose })
        }
      >
        {profileOtherNames(props.profile).length > 0 ? (
          <ProfileOtherNamesControl
            profile={props.profile}
            pending={actions.rename.isPending}
            onPick={(nextLabel) =>
              actions.rename.mutate({ ...request, label: nextLabel })
            }
          />
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={props.onSwitch}
        >
          {SWITCH_ACCOUNT_TEXT}
        </Button>
        <TeamProfileApiKeyForm
          providerId={props.providerId}
          profile={props.profile}
          environmentId={environmentId}
          reread={records.reread}
        />
        {props.profile.apiKey?.configured === true ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={props.onSignIn}
          >
            Sign in again
          </Button>
        )}
      </ProfileEditDialogPresentation>
      <ProfilePersonActionConfirmation
        action="sign-out"
        scope="record"
        profileName={profileDisplayLabel(props.profile)}
        environmentName={teamName}
        open={confirmSignOut}
        onOpenChange={setConfirmSignOut}
        isPending={actions.signOut.isPending}
        blockedReason={null}
        onConfirm={() =>
          actions.signOut.mutate(request, { onSuccess: props.onClose })
        }
      />
    </>
  );
}

function teamProfileEdits(
  profile: ProviderProfile,
  labelOverride: string | null,
  colorOverride: ProviderProfileAccentColor | null,
) {
  const label = labelOverride ?? profile.label;
  const color = colorOverride ?? profile.accentColor;
  return {
    label,
    color,
    changed: label.trim() !== profile.label || color !== profile.accentColor,
    invalid: label.trim().length === 0 || label.trim().length > 64,
  };
}
