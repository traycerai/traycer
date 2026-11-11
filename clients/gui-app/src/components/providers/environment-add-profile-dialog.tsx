import { useId, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { AddProviderProfileDialogProps } from "@/components/settings/panels/add-provider-profile-dialog";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import {
  EnvironmentProfileSignIn,
  type EnvironmentSignInCompletion,
} from "./environment-profile-sign-in";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { CredentialRefusalNote } from "@/components/providers/credential-refusal-note";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

export function EnvironmentAddProfileDialog(
  props: AddProviderProfileDialogProps & {
    readonly client: HostClient<HostRpcRegistry>;
    readonly environmentId: string;
    readonly initialAccentColor: ProviderProfileAccentColor;
    readonly sharesSkillsAndPlugins: boolean;
  },
): ReactNode {
  const shareId = useId();
  const [started, setStarted] = useState(false);
  const [label, setLabel] = useState("New profile");
  const [color, setColor] = useState(props.initialAccentColor);
  const [share, setShare] = useState(props.sharesSkillsAndPlugins);
  const [completion, setCompletion] =
    useState<EnvironmentSignInCompletion | null>(null);
  const recolor = useRecolorProviderProfileForClient(props.client);
  const refusal = useHostCredentialRefusal(props.client.getActiveHostId());
  const finish = (result: EnvironmentSignInCompletion): void => {
    const profile = result.profile;
    if (profile === null) return;
    props.onFailedAttempt(null);
    const alreadyExisted = props.state.profiles.some(
      (row) => row.profileId === profile.profileId,
    );
    if (alreadyExisted || profile.accentColor === color) {
      props.onProfileCreated(profile.profileId);
      props.onOpenChange(false);
      return;
    }
    setCompletion(result);
    recolor.mutate(
      {
        providerId: props.state.providerId,
        profileId: profile.profileId,
        accentColor: color,
      },
      {
        onSuccess: () => {
          props.onProfileCreated(profile.profileId);
          props.onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        layout="banded"
        className="flex max-h-[85dvh] w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            Add new {PROVIDER_DISPLAY_NAMES[props.state.providerId]} profile
          </DialogTitle>
          <DialogDescription>
            Name this profile, choose its color, then sign in once to use it
            everywhere.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 px-5 pb-5">
          <ProviderProfileCard
            profile={null}
            profiles={props.state.profiles}
            label={label}
            onLabelChange={setLabel}
            selectedColor={color}
            onSelectColor={setColor}
            disabled={started}
          />
          {props.sharesSkillsAndPlugins ? (
            <label
              htmlFor={shareId}
              className="flex items-center gap-2 text-ui-sm"
            >
              <Checkbox
                id={shareId}
                checked={share}
                onCheckedChange={(checked) => setShare(checked === true)}
                disabled={started}
              />
              Use terminal skills and plugins on this computer
            </label>
          ) : null}
          <CredentialRefusalNote refusal={refusal} />
          <EnvironmentProfileSignIn
            client={props.client}
            request={{
              providerId: props.state.providerId,
              profileId: null,
              environmentId: props.environmentId,
              createProfile: {
                label: label.trim(),
                shareSkillsAndPlugins: share,
              },
              replaceAccount: false,
            }}
            autoStart={false}
            onStarted={() => setStarted(true)}
            waitForLocalProfile
            disabled={refusal !== null || label.trim().length === 0}
            onComplete={finish}
            onCancel={() => props.onOpenChange(false)}
          />
          {recolor.error !== null && completion !== null ? (
            <>
              <p role="alert" className="text-ui-sm">
                The profile is signed in, but its color could not be saved.
              </p>
              <Button type="button" onClick={() => finish(completion)}>
                Retry
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
