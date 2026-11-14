import { useState, type ReactNode } from "react";
import { z } from "zod";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import type { EnvironmentConfigurationItemWriteResponse } from "@traycer/protocol/host/environment/configuration-contracts";
import { ProfileDropdown } from "@/components/providers/profile-dropdown";
import {
  profileAuthStatusText,
  profilePersonNoticeText,
  resolveProfilePin,
} from "@/components/providers/provider-profile-model";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useConfigurationItemMutations } from "@/hooks/environment/team/use-configuration-item-mutations";
import type { ConfigurationItem } from "@/hooks/environment/team/use-configuration-items-query";
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";
import { useTeamProviderRecords } from "./team-provider-records";
import { TeamProfileEditor } from "./team-profile-editor";
import { TeamProfileLoginDialog } from "./team-profile-login-dialog";
import { SwitchAccountMoveDialog } from "@/components/providers/switch-account-move-dialog";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamReadFailed } from "./team-read-failed";

export function TeamSyncedProviderProfiles(props: {
  readonly providerId: ProviderId;
  readonly items: readonly ConfigurationItem[];
  readonly onOutcome: (
    result: EnvironmentConfigurationItemWriteResponse,
  ) => void;
}): ReactNode {
  const records = useTeamProviderRecords();
  const source = useConfigurationSource();
  const canEdit = useCanEditConfiguration();
  const [move, setMove] = useState<{
    readonly source: ProviderProfile;
    readonly destination: ProviderProfile;
  } | null>(null);
  const { put } = useConfigurationItemMutations();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [login, setLogin] = useState<{
    readonly profile: ProviderProfile | null;
    readonly switchSource: ProviderProfile | null;
  } | null>(null);
  const [session, setSession] = useState(0);
  if (records === null || source.kind !== "pool") return null;
  const { profiles, selected, edited } = teamProfileSelection(
    records.providers,
    props.providerId,
    pickedId,
    editing,
  );
  const startLogin = (
    profile: ProviderProfile | null,
    switchSource: ProviderProfile | null,
  ): void => {
    setSession((current) => current + 1);
    setLogin({ profile, switchSource });
  };
  const setEnabled = (profileId: string | null, enabled: boolean): void => {
    if (!canEdit || put.isPending) return;
    const item = props.items.find(
      (candidate) =>
        candidate.kind === "managed_profile" &&
        candidate.key ===
          `${providerIdToGuiHarnessId(props.providerId)}:${profileId}`,
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
      {
        onSuccess: props.onOutcome,
        onSettled: () => {
          void records.reread();
        },
      },
    );
  };
  if (records.readPending) return <MutedAgentSpinner />;
  if (records.readFailed)
    return (
      <TeamReadFailed
        message={PROVIDER_STATE_UNREADABLE_COPY}
        onRetry={() => void records.reread()}
      />
    );
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-ui-sm font-medium">Profiles</h2>
      {selected === null ? (
        <p className="text-ui-sm text-muted-foreground">No profiles yet</p>
      ) : (
        <TeamSelectedProviderProfile
          providerLabel={providerDisplayName(props.providerId)}
          profile={selected}
          profiles={profiles}
          canEdit={canEdit}
          pending={put.isPending}
          onSelect={setPickedId}
          onSetEnabled={setEnabled}
          onSignIn={() => startLogin(selected, null)}
          onManage={() => setEditing(selected)}
        />
      )}
      {canEdit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => startLogin(null, null)}
        >
          Add a profile
        </Button>
      ) : null}
      {canEdit && edited !== null ? (
        <TeamProfileEditor
          key={edited.profileId}
          providerId={props.providerId}
          profile={edited}
          profiles={profiles}
          onClose={() => setEditing(null)}
          onOutcome={props.onOutcome}
          onSwitch={() => {
            startLogin(null, edited);
            setEditing(null);
          }}
          onSignIn={() => {
            startLogin(edited, null);
            setEditing(null);
          }}
        />
      ) : null}
      {canEdit && login !== null ? (
        <TeamProfileLoginDialog
          key={session}
          providerId={props.providerId}
          profile={login.profile}
          switchSourceProfileId={login.switchSource?.profileId ?? null}
          onSignedIn={(destination) => {
            if (login.switchSource !== null)
              setMove({ source: login.switchSource, destination });
          }}
          environmentId={source.environmentId}
          onClose={() => setLogin(null)}
          onSelect={setPickedId}
          onAddAsNew={() => startLogin(null, login.profile)}
        />
      ) : null}
      {move === null ? null : (
        <TeamProviderSwitchMove
          providerId={props.providerId}
          environmentId={source.environmentId}
          source={move.source}
          destination={move.destination}
          onDone={() => setMove(null)}
        />
      )}
    </section>
  );
}

function TeamSelectedProviderProfile(props: {
  readonly providerLabel: string;
  readonly profile: ProviderProfile;
  readonly profiles: readonly ProviderProfile[];
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onSelect: (profileId: string | null) => void;
  readonly onSetEnabled: (profileId: string | null, enabled: boolean) => void;
  readonly onSignIn: () => void;
  readonly onManage: () => void;
}): ReactNode {
  return (
    <>
      <ProfileDropdown
        providerLabel={props.providerLabel}
        profiles={props.profiles}
        pin={resolveProfilePin(props.profiles, [], props.profile.profileId)}
        onSelectProfile={props.onSelect}
        onCreateProfile={null}
        createProfileDisabled={false}
        createProfileDisabledReason={undefined}
        shortcutHintForIndex={() => null}
        profileEnablementPending={() => props.pending}
        contentContainer={null}
        onCloseAutoFocus={null}
        usagePresentation={null}
        eligibilityControls={{
          pending: () => props.pending,
          disabledReason: () => null,
          onSetEnabled: props.canEdit ? props.onSetEnabled : null,
        }}
        admissionByProfileId={null}
        showTerminalBadge={false}
        terminalComputerName={null}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-ui-xs text-muted-foreground">
          {profilePersonNoticeText(props.profile) ??
            (props.profile.apiKey?.configured === true
              ? "API key set"
              : profileAuthStatusText(props.profile))}
        </p>
        {props.canEdit ? (
          <>
            {props.profile.apiKey?.configured === true ? null : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={props.onSignIn}
              >
                Sign in again
              </Button>
            )}
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={props.onManage}
            >
              Manage
            </Button>
          </>
        ) : null}
      </div>
    </>
  );
}

function teamProfileSelection(
  providers: readonly {
    readonly providerId: string;
    readonly profiles: readonly ProviderProfile[];
  }[],
  providerId: ProviderId,
  pickedId: string | null,
  editing: ProviderProfile | null,
) {
  const profiles =
    providers.find((provider) => provider.providerId === providerId)
      ?.profiles ?? [];
  return {
    profiles,
    selected:
      profiles.find((profile) => profile.profileId === pickedId) ??
      profiles.at(0) ??
      null,
    edited:
      editing === null
        ? null
        : (profiles.find(
            (profile) => profile.profileId === editing.profileId,
          ) ?? editing),
  };
}

/** The sign-in computer and the computer that can count team work may differ. */
function TeamProviderSwitchMove(props: {
  readonly providerId: ProviderId;
  readonly environmentId: string;
  readonly source: ProviderProfile;
  readonly destination: ProviderProfile;
  readonly onDone: () => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const teamName = usePickedTeamLabel(props.environmentId);
  if (teamName === null) return null;
  return (
    <SwitchAccountMoveDialog
      providerId={props.providerId}
      source={{ profileId: props.source.profileId, label: props.source.label }}
      destination={props.destination}
      moveHostId={scope.viewingHost?.hostId ?? null}
      teamName={teamName}
      onDone={props.onDone}
    />
  );
}
