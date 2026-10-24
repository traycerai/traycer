import { useState, type ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  stopManagedFromPreview,
  stopNeedsChoiceFromPreview,
} from "@/components/settings/move/stop-preview-rows";
import {
  stopRowAddress,
  type StopChoiceEntry,
} from "@/components/settings/move/stop-sharing-choices";
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
  // The needs-choice rows the person answered when the host refused the stop
  // as `choices_missing`; null until it does. The preview is read again, and
  // shows the loading state until the new one arrives.
  const [answeredBeforeChange, setAnsweredBeforeChange] =
    useState<ReadonlySet<string> | null>(null);
  const refreshing = answeredBeforeChange !== null && preview.isFetching;
  const previewStatus = refreshing
    ? "loading"
    : stopPreviewStatus(supported, preview);
  const managed =
    preview.data === undefined ? [] : stopManagedFromPreview(preview.data);
  const needsChoice =
    preview.data === undefined ? [] : stopNeedsChoiceFromPreview(preview.data);
  const changedRows =
    answeredBeforeChange === null
      ? null
      : needsChoice.filter(
          (row) => !answeredBeforeChange.has(stopRowAddress(row)),
        );

  const onOpenChange = (open: boolean): void => {
    if (!open) setAnsweredBeforeChange(null);
    props.onOpenChange(open);
  };

  const onStop = (choices: readonly StopChoiceEntry[]): void => {
    const answered = new Set(needsChoice.map(stopRowAddress));
    stop.mutate(
      {
        choices: choices.map((entry) => ({
          kind: entry.kind,
          key: entry.key,
          choice: entry.choice,
        })),
      },
      {
        onSuccess: (data) => {
          if (data.outcome === "choices_missing") {
            setAnsweredBeforeChange(answered);
            void preview.refetch();
            return;
          }
          onOpenChange(false);
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
      changedRows={changedRows}
      previewStatus={previewStatus}
      confirmPending={stop.isPending}
      onOpenChange={onOpenChange}
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
