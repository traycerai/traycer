import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuthService } from "@/lib/host";
import { environmentMutationKeys } from "@/lib/query-keys";
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
import {
  providerDisplayName,
  providerIdToGuiHarnessId,
} from "@/lib/provider-ordering";
import { PROVIDER_STATE_UNREADABLE_COPY } from "@/lib/providers/provider-settings-unreadable-error";
import {
  useCanEditConfiguration,
  useConfigurationSource,
} from "./configuration-source";
import {
  useTeamProviderRecords,
  type TeamProviderRecords,
} from "./team-provider-records";
import { TeamProfileEditor } from "./team-profile-editor";
import { TeamProfileLoginDialog } from "./team-profile-login-dialog";
import { SwitchAccountMoveDialog } from "@/components/providers/switch-account-move-dialog";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamReadFailed } from "./team-read-failed";

export function TeamSyncedProviderProfiles(props: {
  readonly providerId: ProviderId;
  readonly fallback: ReactNode;
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
  const auth = useAuthService();
  const put = useMutation({
    mutationKey: environmentMutationKeys.providersSetEnabled(),
    retry: false,
    mutationFn: async (request: {
      readonly environmentId: string;
      readonly profileId: string;
      readonly enabled: boolean;
    }) => {
      const result = await auth.setProfileRecordEnabled(
        request.environmentId,
        providerIdToGuiHarnessId(props.providerId),
        { profileId: request.profileId, enabled: request.enabled },
        null,
      );
      if (result.kind === "forbidden")
        throw new Error("You don't have permission to do that.");
      if (result.kind === "conflict")
        throw new Error("This connection changed. Refresh and try again.");
      if (result.kind === "failed")
        throw new Error("Couldn't update profile availability.");
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => records?.reread(),
  });
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderProfile | null>(null);
  const [login, setLogin] = useState<{
    readonly profile: ProviderProfile | null;
    readonly switchSource: ProviderProfile | null;
  } | null>(null);
  const [session, setSession] = useState(0);
  if (source.kind !== "pool") return null;
  const { profiles, selected, edited } = teamProfileSelection(
    records?.providers ?? [],
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
    if (!canEdit || put.isPending || profileId === null) return;
    put.mutate({ environmentId: source.environmentId, profileId, enabled });
  };
  return (
    <>
      <TeamProviderProfileRows
        records={records}
        fallback={props.fallback}
        providerLabel={providerDisplayName(props.providerId)}
        selected={selected}
        profiles={profiles}
        canEdit={canEdit}
        pending={put.isPending}
        onSelect={setPickedId}
        onSetEnabled={setEnabled}
        onSignIn={() => startLogin(selected, null)}
        onManage={() => setEditing(selected)}
        onAdd={() => startLogin(null, null)}
      />
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
      {login !== null ? (
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
    </>
  );
}

function TeamProviderProfileRows(props: {
  readonly records: TeamProviderRecords | null;
  readonly fallback: ReactNode;
  readonly providerLabel: string;
  readonly selected: ProviderProfile | null;
  readonly profiles: readonly ProviderProfile[];
  readonly canEdit: boolean;
  readonly pending: boolean;
  readonly onSelect: (profileId: string | null) => void;
  readonly onSetEnabled: (profileId: string | null, enabled: boolean) => void;
  readonly onSignIn: () => void;
  readonly onManage: () => void;
  readonly onAdd: () => void;
}): ReactNode {
  const records = props.records;
  if (records === null) return props.fallback;
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
      {props.selected === null ? (
        <p className="text-ui-sm text-muted-foreground">No profiles yet</p>
      ) : (
        <TeamSelectedProviderProfile
          providerLabel={props.providerLabel}
          profile={props.selected}
          profiles={props.profiles}
          canEdit={props.canEdit}
          pending={props.pending}
          onSelect={props.onSelect}
          onSetEnabled={props.onSetEnabled}
          onSignIn={props.onSignIn}
          onManage={props.onManage}
        />
      )}
      {props.canEdit ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          onClick={props.onAdd}
        >
          Add a profile
        </Button>
      ) : null}
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
