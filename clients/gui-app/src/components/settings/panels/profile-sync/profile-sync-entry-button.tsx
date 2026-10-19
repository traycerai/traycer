import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { Button } from "@/components/ui/button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostCredentialRefusal } from "@/hooks/host/use-host-credential-refusal";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { profileSyncWireProvider } from "@/lib/profile-sync/profile-sync-presentation";
import { useProfileSyncModalStore } from "@/stores/settings/profile-sync-modal-store";

/**
 * Opens the Sync profiles dialog for the host this Profiles section shows.
 * Rendered only under a provider sync covers; the dialog itself is about every
 * supported profile on the device, not this provider's alone.
 */
export function ProfileSyncEntryButton(props: {
  readonly hostId: string | null;
  readonly providerId: ProviderId;
}): ReactNode {
  return props.hostId === null ||
    profileSyncWireProvider(props.providerId) === null ? null : (
    <ProfileSyncAvailableEntry hostId={props.hostId} />
  );
}

function ProfileSyncAvailableEntry(props: {
  readonly hostId: string;
}): ReactNode {
  const supported = useHostMethodSupport(
    props.hostId,
    "providers.profileSync.overview",
  );
  const open = useProfileSyncModalStore((state) => state.open);
  // A sandbox is never a sync source (or target): profiles are credentials.
  const credentialRefusal = useHostCredentialRefusal(props.hostId);
  let label = "Update Traycer on this device to sync profiles.";
  if (supported === true)
    label = "Sync profiles from this device to your other devices.";
  if (supported === null) label = "Checking device support…";
  if (credentialRefusal !== null) label = credentialRefusal;
  return (
    <TooltipWrapper label={label} side="top" sideOffset={4} align="center">
      {/* Span between the tooltip and the button because a `disabled` button
          emits no pointer events for Radix to hover-detect. */}
      <span className="inline-flex">
        <Button
          size="xs"
          variant="outline"
          disabled={supported !== true || credentialRefusal !== null}
          onClick={() => {
            if (credentialRefusal === null) open(props.hostId);
          }}
        >
          <RefreshCw data-icon="inline-start" />
          Sync profiles…
        </Button>
      </span>
    </TooltipWrapper>
  );
}
