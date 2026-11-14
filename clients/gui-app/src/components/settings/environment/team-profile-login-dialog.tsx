import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ProviderId,
  ProviderProfile,
  ProviderCliState,
} from "@traycer/protocol/host/provider-schemas";
import {
  AddProviderProfileDialog,
  AddProfileWaitingStep,
  type ProviderTargetLoginControls,
} from "@/components/settings/panels/add-provider-profile-dialog";
import {
  providerProfileLoginProgress,
  useProviderDestinationLoginFlow,
  type ProviderTargetLoginResult,
} from "@/components/settings/panels/use-provider-profile-login-flow";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersStartLoginForClient } from "@/hooks/providers/use-providers-start-login-mutation";
import { useProvidersDestinationAwaitLoginForClient } from "@/hooks/providers/use-providers-await-login-mutation";
import { useProvidersCancelLoginForClient } from "@/hooks/providers/use-providers-cancel-login-mutation";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersSubmitLoginCodeForClient } from "@/hooks/providers/use-providers-submit-login-code-mutation";
import { useProvidersTouchLoginForClient } from "@/hooks/providers/use-providers-touch-login-mutation";
import { useProvidersLoginOwnershipForClient } from "@/hooks/providers/use-providers-login-ownership";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveLocalHostId } from "@/hooks/host/use-reactive-local-host-id";
import { useOpenLink } from "@/lib/links/open-link";
import { Button } from "@/components/ui/button";
import { MutedAgentSpinner } from "@/components/ui/agent-spinning-dots";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePickedTeamLabel } from "./team-pick-label";
import { TeamProfileLoginResult } from "./team-profile-login-result";

interface TeamLoginProps {
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile | null;
  readonly switchSourceProfileId: string | null;
  readonly onSignedIn: (profile: ProviderProfile) => void;
  readonly environmentId: string;
  readonly onClose: () => void;
  readonly onSelect: (profileId: string) => void;
  readonly onAddAsNew: () => void;
}

export function TeamProfileLoginDialog(props: TeamLoginProps): ReactNode {
  const caller = useHostClient();
  const [loginHostId] = useState(() => caller.getActiveHostId());
  const client = useHostClientForHostId(loginHostId);
  const localHostId = useReactiveLocalHostId();
  const isLocalHost = loginHostId !== null && loginHostId === localHostId;
  const catalog = useProvidersListForClient(client, {
    enabled: client !== null,
    subscribed: true,
  });
  const state = catalog.data?.providers.find(
    (provider) => provider.providerId === props.providerId,
  );
  const teamName = usePickedTeamLabel(props.environmentId);
  if (teamName === null) return null;
  if (state === undefined)
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {props.profile === null ? "Add a profile" : "Sign in again"}
            </DialogTitle>
          </DialogHeader>
          {catalog.isPending && client !== null ? (
            <MutedAgentSpinner />
          ) : (
            <>
              <p>{`This computer can't sign in for ${teamName}. Use another computer.`}</p>
              <Button type="button" onClick={props.onClose}>
                Done
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  if (props.profile !== null)
    return (
      <TeamProfileReauthDialog
        {...props}
        state={state}
        profile={props.profile}
        teamName={teamName}
        client={client}
        isLocalHost={isLocalHost}
      />
    );
  return (
    <TeamAddLoginContext.Provider value={{ ...props, teamName }}>
      <AddProviderProfileDialog
        state={state}
        client={client}
        isLocalHost={isLocalHost}
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        onFailedAttempt={() => {}}
        onProfileCreated={(profileId) => {
          props.onSelect(profileId);
          props.onClose();
        }}
        target={{
          kind: "environment",
          environmentId: props.environmentId,
          profileId: null,
        }}
        targetResult={renderTeamAddLoginResult}
      />
    </TeamAddLoginContext.Provider>
  );
}

function TeamProfileReauthDialog(
  props: TeamLoginProps & {
    readonly state: ProviderCliState;
    readonly client: HostClient<HostRpcRegistry> | null;
    readonly isLocalHost: boolean;
    readonly profile: ProviderProfile;
    readonly teamName: string;
  },
): ReactNode {
  const client = props.client;
  const openLink = useOpenLink();
  const startLogin = useProvidersStartLoginForClient(client);
  const awaitLogin = useProvidersDestinationAwaitLoginForClient(
    { client, getCacheHostId: () => client?.getActiveHostId() ?? null },
    true,
  );
  const cancelLogin = useProvidersCancelLoginForClient(client);
  const submitLoginCode = useProvidersSubmitLoginCodeForClient(client);
  const touchLogin = useProvidersTouchLoginForClient(client);
  const ensurePack = useProvidersEnsurePackForClient(client);
  const supportsLoginOwnership = useProvidersLoginOwnershipForClient(client);
  const flow = useProviderDestinationLoginFlow(
    {
      hostBlock: null,
      supportsLoginOwnership,
      mode: "reauth",
      providerId: props.providerId,
      existingProfileId: null,
      loginCapability: props.state.loginCapability,
      startLogin,
      awaitLogin,
      cancelLogin,
      submitLoginCode,
      touchLogin,
      ensurePack,
      failureMessages: {
        notStarted: "Sign-in did not start. Try again when ready.",
        notFinished: "Sign-in did not finish. Try again.",
      },
      onFailed: () => {},
    },
    null,
    {
      kind: "environment",
      environmentId: props.environmentId,
      profileId: props.profile.profileId,
    },
    client,
  );
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      flow.start({ label: null, shareSkillsAndPlugins: false });
    }
  }, [flow]);
  const settled =
    flow.state.kind === "target-refused" ||
    flow.state.kind === "target-outcome" ||
    flow.state.kind === "failed";
  const close = (): void => {
    if (!settled) flow.cancel();
    props.onClose();
  };
  let body: ReactNode;
  if (
    flow.state.kind === "target-refused" ||
    flow.state.kind === "target-outcome"
  ) {
    body = (
      <TeamProfileLoginResult
        {...props}
        result={flow.state}
        controls={null}
        entryProfile={props.profile}
      />
    );
  } else if (flow.state.kind === "failed") {
    body = (
      <>
        <p role="status">{flow.state.message}</p>
        <Button type="button" onClick={close}>
          Done
        </Button>
      </>
    );
  } else {
    body = (
      <AddProfileWaitingStep
        {...providerProfileLoginProgress(flow.state)}
        loginCapability={props.state.loginCapability}
        isLocalHost={props.isLocalHost}
        queuePending={flow.startPending}
        startingCopy={flow.startingCopy}
        cancelPending={flow.cancelPending}
        cancelDisabled={flow.commitPending}
        codePaste={flow.codePaste}
        onOpenExternalLink={(url) => {
          void openLink(url, "auth", null);
        }}
        onCancel={close}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !flow.commitPending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in again</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

const TeamAddLoginContext = createContext<
  (TeamLoginProps & { readonly teamName: string }) | null
>(null);

function renderTeamAddLoginResult(
  result: ProviderTargetLoginResult,
  controls: ProviderTargetLoginControls,
): ReactNode {
  return <TeamAddLoginResult result={result} controls={controls} />;
}

function TeamAddLoginResult(props: {
  readonly result: ProviderTargetLoginResult;
  readonly controls: ProviderTargetLoginControls;
}): ReactNode {
  const context = useContext(TeamAddLoginContext);
  if (context === null) return null;
  return (
    <TeamProfileLoginResult
      {...context}
      result={props.result}
      controls={props.controls}
      entryProfile={null}
    />
  );
}
