import type { ReactNode } from "react";
import { Copy } from "lucide-react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  profileCopyEntryEligible,
  profileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import { useProfileCopyHosts } from "./profile-copy-shared";

/**
 * Every source verb a copy needs, retry included. A host that advertises
 * only some of them cannot finish what it starts, so the entry waits for all.
 */
function useSourceCopySupport(hostId: string): boolean | null {
  const preview = useHostMethodSupport(hostId, "providers.profileCopy.preview");
  const start = useHostMethodSupport(hostId, "providers.profileCopy.start");
  const status = useHostMethodSupport(hostId, "providers.profileCopy.status");
  const cancel = useHostMethodSupport(hostId, "providers.profileCopy.cancel");
  const retry = useHostMethodSupport(hostId, "providers.profileCopy.retry");
  const answers = [preview, start, status, cancel, retry];
  if (answers.some((answer) => answer === false)) return false;
  if (answers.some((answer) => answer === null)) return null;
  return true;
}

/**
 * "Copy to devices…" for one managed profile. The host this profile lives on
 * is captured at the click and handed to the copy dialog; nothing after that
 * reads which host Settings is showing.
 */
export function ProfileCopyEntryButton(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile;
}): ReactNode {
  if (props.hostId === null) return null;
  if (!profileCopyEntryEligible(props.providerId, props.profile)) return null;
  return (
    <ProfileCopyEntryButtonForHost
      sourceHostId={props.hostId}
      providerId={props.providerId}
      profile={props.profile}
    />
  );
}

function ProfileCopyEntryButtonForHost(props: {
  readonly sourceHostId: string;
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile;
}): ReactNode {
  const { sourceHostId, profile } = props;
  const provider = profileCopyWireProvider(props.providerId);
  const hosts = useProfileCopyHosts();
  const supported = useSourceCopySupport(sourceHostId);
  const openFlow = useProfileCopyFlowStore((state) => state.open);
  if (provider === null) return null;
  const sourceName = hosts.nameFor(sourceHostId);
  const hasOtherHost = hosts.options.some(
    (host) => host.hostId !== sourceHostId,
  );

  let disabledReason: string | null = null;
  if (supported === null) {
    disabledReason = `Checking what ${sourceName} supports…`;
  } else if (!supported) {
    disabledReason = `Update Traycer on ${sourceName} to copy profiles.`;
  } else if (!hasOtherHost) {
    disabledReason =
      "Add another device to your account to copy this profile to it.";
  }

  return (
    <TooltipWrapper
      label={
        disabledReason ??
        "Copy this profile's name, color and settings to your other devices."
      }
      side="bottom"
      sideOffset={6}
      align="end"
    >
      {/* A disabled button emits no pointer events, so the span carries the
          hover that explains why it is disabled. */}
      <span className="inline-flex">
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={disabledReason !== null}
          onClick={() =>
            openFlow({
              kind: "new",
              sourceHostId,
              providerId: provider,
              sourceProfileId: profile.profileId,
            })
          }
        >
          <Copy data-icon="inline-start" />
          Copy to devices…
        </Button>
      </span>
    </TooltipWrapper>
  );
}
