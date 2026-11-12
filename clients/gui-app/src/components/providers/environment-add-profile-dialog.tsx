import { useId, useRef, useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderProfileAccentColor,
} from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import type { AddProviderProfileDialogProps } from "@/components/settings/panels/add-provider-profile-dialog";
import { ProviderProfileCard } from "@/components/providers/provider-profile-card";
import { EnvironmentProfileSignIn } from "./environment-profile-sign-in";
import { useRecolorProviderProfileForClient } from "@/hooks/providers/use-recolor-provider-profile-mutation";
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
  const [shareTerminalTools, setShareTerminalTools] = useState(true);
  const share = props.sharesSkillsAndPlugins && shareTerminalTools;
  const [completionProfileId, setCompletionProfileId] = useState<string | null>(
    null,
  );
  const recolor = useRecolorProviderProfileForClient(props.client);
  const profileIdsBeforeSignIn = useRef<ReadonlySet<string>>(new Set());
  const signInColor = useRef(color);
  const changeOpen = (open: boolean): void => {
    if (!open && recolor.isPending) return;
    props.onOpenChange(open);
  };
  const finish = (profileId: string, alreadyChosenColor: boolean): void => {
    props.onFailedAttempt(null);
    const alreadyExisted = profileIdsBeforeSignIn.current.has(profileId);
    if (alreadyExisted || alreadyChosenColor) {
      props.onProfileCreated(profileId);
      props.onOpenChange(false);
      return;
    }
    setCompletionProfileId(profileId);
    recolor.mutate(
      {
        providerId: props.state.providerId,
        profileId,
        accentColor: signInColor.current,
      },
      {
        onSuccess: () => {
          props.onProfileCreated(profileId);
          props.onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog open={props.open} onOpenChange={changeOpen}>
      <DialogContent
        layout="banded"
        className="flex max-h-[min(85dvh,calc(var(--spacing-safe-dvh)-var(--spacing-safe-bottom)))] w-full flex-col overflow-y-auto sm:max-w-lg"
        showCloseButton={!recolor.isPending}
      >
        <DialogHeader>
          <DialogTitle>
            Add new {PROVIDER_DISPLAY_NAMES[props.state.providerId]} profile
          </DialogTitle>
          <DialogDescription>
            Name this profile, choose its color, then sign in.
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
                onCheckedChange={(checked) =>
                  setShareTerminalTools(checked === true)
                }
                disabled={started}
              />
              Use terminal skills and plugins on this computer
            </label>
          ) : null}
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
            onActiveChange={(active) => {
              if (active) {
                profileIdsBeforeSignIn.current = new Set(
                  props.state.profiles.map((profile) => profile.profileId),
                );
                signInColor.current = color;
              }
              setStarted(active);
            }}
            waitForLocalProfile
            disabled={label.trim().length === 0 || recolor.isPending}
            onComplete={({ profile }) => {
              if (profile !== null)
                finish(
                  profile.profileId,
                  profile.accentColor === signInColor.current,
                );
            }}
            onDeliveryPending={(profileId) => {
              if (profileId === null) changeOpen(false);
              else finish(profileId, false);
            }}
            onCancel={() => changeOpen(false)}
          />
          {recolor.error !== null && completionProfileId !== null ? (
            <>
              <p role="alert" className="text-ui-sm">
                The profile is signed in, but its color could not be saved.
              </p>
              <Button
                type="button"
                onClick={() => finish(completionProfileId, false)}
              >
                Retry
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
