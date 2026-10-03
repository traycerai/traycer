import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type {
  ProviderId,
  ProviderProfile,
} from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useProfileCopyFlowStore } from "@/stores/settings/profile-copy-flow-store";
import {
  profileCopyWireProvider,
  type ProfileCopyWireProvider,
} from "@/lib/profile-copy/profile-copy-model";
import { ProfileCopyEntryButton } from "../profile-copy/profile-copy-entry-button";

export function ProfileSyncEntryButton(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
  readonly profile: ProviderProfile | null;
}): ReactNode {
  const providerId = profileCopyWireProvider(props.providerId);
  return props.hostId === null || providerId === null ? null : (
    <ProfileSyncAvailableEntry
      hostId={props.hostId}
      providerId={providerId}
      sourceProviderId={props.providerId}
      profile={props.profile}
    />
  );
}
function ProfileSyncAvailableEntry(props: {
  readonly hostId: string;
  readonly providerId: ProfileCopyWireProvider;
  readonly sourceProviderId: ProviderId;
  readonly profile: ProviderProfile | null;
}): ReactNode {
  const supported = useSourceSyncSupport(props.hostId);
  const open = useProfileCopyFlowStore((s) => s.open);
  if (supported === false && props.profile !== null)
    return (
      <ProfileCopyEntryButton
        hostId={props.hostId}
        providerId={props.sourceProviderId}
        profile={props.profile}
      />
    );
  let label = "Update Traycer on this device to sync profiles.";
  if (supported === true)
    label = "Sync profiles from this device to your other devices.";
  if (supported === null) label = "Checking device support…";
  return (
    <TooltipWrapper label={label} side="top" sideOffset={4} align="center">
      <span className="inline-flex">
        <Button
          size="xs"
          variant="outline"
          disabled={supported !== true}
          onClick={() =>
            open({
              kind: "sync",
              sourceHostId: props.hostId,
              providerId: props.providerId,
            })
          }
        >
          <RefreshCw data-icon="inline-start" />
          Sync profiles…
        </Button>
      </span>
    </TooltipWrapper>
  );
}

/** The shared modal exposes runs, rules, resolution and transfer retries. */
function useSourceSyncSupport(hostId: string): boolean | null {
  const preview = useHostMethodSupport(
    hostId,
    "providers.profileCopy.sync.preview",
  );
  const list = useHostMethodSupport(hostId, "providers.profileCopy.sync.list");
  const start = useHostMethodSupport(
    hostId,
    "providers.profileCopy.sync.start",
  );
  const saveRule = useHostMethodSupport(
    hostId,
    "providers.profileCopy.sync.saveRule",
  );
  const stopRule = useHostMethodSupport(
    hostId,
    "providers.profileCopy.sync.stopRule",
  );
  const resolve = useHostMethodSupport(
    hostId,
    "providers.profileCopy.sync.resolve",
  );
  const retry = useHostMethodSupport(hostId, "providers.profileCopy.retry");
  const answers = [preview, list, start, saveRule, stopRule, resolve, retry];
  if (answers.some((answer) => answer === false)) return false;
  if (answers.some((answer) => answer === null)) return null;
  return true;
}
