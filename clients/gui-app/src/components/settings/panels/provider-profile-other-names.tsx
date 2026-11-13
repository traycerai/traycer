import type { ReactNode } from "react";
import type {
  ProviderProfile,
  ProvidersAnswerProfileNameRequest,
} from "@traycer/protocol/host/provider-schemas";
import { SettingsSegmentedControl } from "@/components/settings/controls/settings-segmented-control";
import {
  keepNameAndHideText,
  otherNamesPromptText,
} from "@/components/providers/profile-sync-copy";
import { profileOtherNames } from "@/components/providers/provider-profile-model";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProvidersAnswerProfileNameForClient } from "@/hooks/providers/use-providers-answer-profile-name-mutation";
import { useHostClient } from "@/lib/host";

/**
 * The account's other names, in its details: pick the name every computer
 * uses, or keep the current one and hide this. Either one, or Rename, clears
 * the other names, and the block leaves with them.
 */
export function ProfileOtherNames(props: {
  readonly hostId: string | null;
  readonly providerId: ProvidersAnswerProfileNameRequest["providerId"];
  readonly profile: ProviderProfile;
}): ReactNode {
  const { profile } = props;
  const supported =
    useHostMethodSupport(props.hostId, "providers.answerProfileName") === true;
  const answerName = useProvidersAnswerProfileNameForClient(useHostClient());
  const otherNames = profileOtherNames(profile);
  if (!supported || otherNames.length === 0) return null;

  const names = [...new Set([profile.label, ...otherNames])];
  const pickName = (label: string): void => {
    if (answerName.isPending) return;
    answerName.mutate({
      providerId: props.providerId,
      profileId: profile.profileId,
      label,
    });
  };

  return (
    <div className="flex flex-col items-start gap-2 text-ui-xs text-muted-foreground">
      <p className="whitespace-normal break-words">
        {otherNamesPromptText(names.length)}
      </p>
      <SettingsSegmentedControl
        value={profile.label}
        options={names.map((name) => ({ value: name, label: name }))}
        onChange={pickName}
        ariaLabel="Account name"
        disabled={answerName.isPending}
      />
      <span className="inline-flex items-center gap-1.5">
        <Button
          type="button"
          variant="link"
          size="inline-xs"
          disabled={answerName.isPending}
          onClick={() => pickName(profile.label)}
        >
          {keepNameAndHideText(profile.label)}
        </Button>
        {answerName.isPending ? (
          <AgentSpinningDots
            className={undefined}
            testId={undefined}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </span>
    </div>
  );
}
