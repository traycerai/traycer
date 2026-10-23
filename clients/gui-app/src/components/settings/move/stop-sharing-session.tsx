import { type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  stopManagedFromPreview,
  stopNeedsChoiceFromPreview,
} from "@/components/settings/move/stop-preview-rows";
import { type StopChoiceEntry } from "@/components/settings/move/stop-sharing-choices";
import {
  StopSharingSheet,
  type StopPreviewStatus,
} from "@/components/settings/move/stop-sharing-sheet";
import { useEnvironmentMoveStopMutation } from "@/hooks/environment/use-environment-move-stop-mutation";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import type { HostRpcRegistry } from "@/lib/host";

export function StopSharingSession(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const supported = useHostMethodSupport(
    props.hostId,
    "environment.move.stopPreview",
  );
  const preview = useHostQuery<HostRpcRegistry, "environment.move.stopPreview">(
    {
      cacheKeyIdentity: undefined,
      client: props.client,
      method: "environment.move.stopPreview",
      params: {},
      options: {
        enabled: props.open && props.hostId !== null && supported === true,
      },
    },
  );
  const stop = useEnvironmentMoveStopMutation(props.client);
  const previewStatus = stopPreviewStatus(supported, preview);
  const managed =
    preview.data === undefined ? [] : stopManagedFromPreview(preview.data);
  const needsChoice =
    preview.data === undefined ? [] : stopNeedsChoiceFromPreview(preview.data);

  const onStop = (choices: readonly StopChoiceEntry[]): void => {
    stop.mutate(
      {
        choices: choices.map((entry) => ({
          key: entry.key,
          choice: entry.choice,
        })),
      },
      {
        onSuccess: (data) => {
          if (data.outcome === "choices_missing") return;
          props.onOpenChange(false);
        },
      },
    );
  };

  return (
    <StopSharingSheet
      open={props.open}
      hostName={props.hostName}
      managed={managed}
      needsChoice={needsChoice}
      previewStatus={previewStatus}
      confirmPending={stop.isPending}
      onOpenChange={props.onOpenChange}
      onStop={onStop}
    />
  );
}

function stopPreviewStatus(
  supported: boolean | null,
  preview: { readonly isError: boolean; readonly data: unknown },
): StopPreviewStatus {
  if (supported === false || preview.isError) return "failed";
  if (preview.data !== undefined) return "ready";
  return "loading";
}
