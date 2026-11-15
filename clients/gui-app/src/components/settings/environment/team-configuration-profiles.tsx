import { useState, type ReactNode } from "react";
import { z } from "zod";
import {
  providerProfileAccentColorSchema,
  type ProviderProfile,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { ProfileDropdown } from "@/components/providers/profile-dropdown";
import { profileDisplayLabel } from "@/components/providers/provider-profile-model";
import { ProfileSummaryActions } from "@/components/settings/panels/profile-summary-actions";
import { ProfileEditDialogPresentation } from "@/components/settings/panels/profile-edit-dialog-presentation";
import { configurationProfileValueSchema } from "@/hooks/environment/team/configuration-item-values";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";

/** Configuration profiles have no live auth or usage standing. */
function pickerProfile(item: ConfigurationItem): ProviderProfile {
  const value = configurationProfileValueSchema.parse(item.value);
  return {
    profileId: item.key,
    kind: "managed",
    label: value.name,
    accentColor: providerProfileAccentColorSchema
      .nullable()
      .catch(null)
      .parse(value.color),
    enabled: value.enabled,
    authType: "oauth",
    auth: { status: "unknown", badgeText: null, label: null, detail: null },
    identity: null,
    usageUpdatedAt: null,
    rateLimitStatus: "unknown",
    rateLimitLimitedScopes: null,
    duplicateOfProfileId: null,
    ambientDriftNotice: null,
  };
}

/**
 * A team's profiles in the personal profile picker. An editor turns each
 * profile on or off from its row and manages the selected one; a reader sees
 * On or Off and no Manage profile. A team profile has no sign-in, so there is
 * no Add a profile and no Sign in.
 */
export function ConfigurationProfiles(props: {
  readonly providerLabel: string;
  readonly profiles: readonly ConfigurationItem[];
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const { put } = useConfigurationItemMutations();
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editSession, setEditSession] = useState(0);
  if (props.profiles.length === 0) return null;
  const selected =
    props.profiles.find((item) => item.key === pickedKey) ?? props.profiles[0];
  const profiles = props.profiles.map(pickerProfile);
  const value = configurationProfileValueSchema.parse(selected.value);
  const setEnabled = (profileId: string | null, enabled: boolean): void => {
    if (!canEdit || source.kind !== "pool" || put.isPending) return;
    const item = props.profiles.find(
      (candidate) => candidate.key === profileId,
    );
    if (item === undefined) return;
    put.mutate(
      {
        environmentId: source.environmentId,
        kind: "managed_profile",
        key: item.key,
        os: null,
        value: { ...z.record(z.string(), z.json()).parse(item.value), enabled },
        revision: item.revision,
      },
      { onSuccess: props.onOutcome },
    );
  };
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-ui-sm font-medium">Profiles</h2>
      <ProfileDropdown
        providerLabel={props.providerLabel}
        profiles={profiles}
        activeProfileId={selected.key}
        onSelectProfile={setPickedKey}
        onCreateProfile={null}
        createProfileDisabled={false}
        createProfileDisabledReason={undefined}
        shortcutHintForIndex={() => null}
        profileEnablementPending={() => put.isPending}
        contentContainer={null}
        onCloseAutoFocus={null}
        usagePresentation={null}
        eligibilityControls={{
          pending: () => put.isPending,
          disabledReason: () => null,
          onSetEnabled: canEdit ? setEnabled : null,
        }}
        admissionByProfileId={null}
        showTerminalBadge={false}
      />
      <ProfileSummaryActions
        onManage={
          canEdit
            ? () => {
                setEditSession(editSession + 1);
                setEditOpen(true);
              }
            : null
        }
        managementHeldReason={null}
        manageHint="Change the profile name and accent color, or remove this profile."
      >
        {value.accountIdentity === null ? null : (
          <p className="min-w-0 flex-auto whitespace-normal break-words text-ui-xs text-muted-foreground">
            {value.accountIdentity}
          </p>
        )}
      </ProfileSummaryActions>
      {canEdit ? (
        <ConfigurationProfileEditor
          key={`${selected.key}:${editSession}`}
          item={selected}
          profiles={profiles}
          open={editOpen}
          onOpenChange={setEditOpen}
          onOutcome={props.onOutcome}
        />
      ) : null}
    </section>
  );
}

function ConfigurationProfileEditor(props: {
  readonly item: ConfigurationItem;
  readonly profiles: readonly ProviderProfile[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const source = useConfigurationSource();
  const { put, remove } = useConfigurationItemMutations();
  // The stored profile the fields show (`baseline`) and this person's edits
  // over it are one snapshot: a save or remove names the baseline's revision,
  // so an edit typed over a profile a teammate has since changed is refused,
  // never written over a value the fields did not show. A newer read becomes
  // the baseline while nothing is edited, or once a save is refused as out of
  // date; an edit survives it only where the newer read left that field as it
  // was. A picked color is never null, so null means untouched.
  const [baseline, setBaseline] = useState(props.item);
  const [adoptNext, setAdoptNext] = useState(false);
  const [labelOverride, setLabel] = useState<string | null>(null);
  const [accentColorOverride, setAccentColor] =
    useState<ProviderProfileAccentColor | null>(null);
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false);
  const profile = pickerProfile(baseline);
  const label = labelOverride ?? profile.label;
  const accentColor = accentColorOverride ?? profile.accentColor;
  const trimmedLabel = label.trim();
  const invalid = trimmedLabel.length === 0 || trimmedLabel.length > 64;
  const changed =
    (labelOverride !== null && trimmedLabel !== profile.label) ||
    (accentColorOverride !== null &&
      accentColorOverride !== profile.accentColor);
  if (props.item.revision !== baseline.revision && (adoptNext || !changed)) {
    const next = pickerProfile(props.item);
    setBaseline(props.item);
    if (next.label !== profile.label) setLabel(null);
    if (next.accentColor !== profile.accentColor) setAccentColor(null);
    setAdoptNext(false);
  }
  const busy = put.isPending || remove.isPending;
  const onSuccess = (
    result: EnvironmentConfigurationItemWriteResponse,
  ): void => {
    props.onOutcome(result);
    if (result.outcome === "conflict") setAdoptNext(true);
    if (result.outcome !== "saved") return;
    props.onOpenChange(false);
    setConfirmRemoveOpen(false);
  };
  const save = (): void => {
    if (source.kind !== "pool" || busy || invalid || !changed) return;
    put.mutate(
      {
        environmentId: source.environmentId,
        kind: "managed_profile",
        key: baseline.key,
        os: null,
        value: {
          ...z.record(z.string(), z.json()).parse(baseline.value),
          ...(labelOverride === null ? {} : { name: trimmedLabel }),
          ...(accentColorOverride === null
            ? {}
            : { color: accentColorOverride }),
        },
        revision: baseline.revision,
      },
      { onSuccess },
    );
  };
  const confirmRemove = (): void => {
    if (source.kind !== "pool" || busy) return;
    remove.mutate(
      {
        environmentId: source.environmentId,
        kind: "managed_profile",
        key: baseline.key,
        os: null,
        revision: baseline.revision,
      },
      { onSuccess },
    );
  };
  const error = put.error ?? remove.error;
  return (
    <ProfileEditDialogPresentation
      profile={profile}
      profiles={props.profiles}
      title="Edit profile"
      description={`Update how ${profileDisplayLabel(profile)} appears.`}
      open={props.open}
      onOpenChange={props.onOpenChange}
      switchingAccount={false}
      label={label}
      onLabelChange={setLabel}
      accentColor={accentColor}
      onSelectColor={setAccentColor}
      savePending={busy}
      changed={changed}
      invalid={invalid}
      onSave={save}
      footerAction={null}
      removePending={remove.isPending}
      removeDisabledReason={null}
      removeAriaLabel="Remove profile"
      onRequestRemove={() => {
        props.onOpenChange(false);
        setConfirmRemoveOpen(true);
      }}
      confirmRemoveOpen={confirmRemoveOpen}
      onConfirmRemoveOpenChange={setConfirmRemoveOpen}
      removeDescription="Remove this profile from the team."
      onConfirmRemove={confirmRemove}
    >
      {error === null ? null : (
        <p className="text-ui-xs text-destructive">{error.message}</p>
      )}
    </ProfileEditDialogPresentation>
  );
}
