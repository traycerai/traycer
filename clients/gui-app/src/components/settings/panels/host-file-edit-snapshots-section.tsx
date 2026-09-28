import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostQuery, useHostMutation } from "@/hooks/host/use-host-query";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalSnapshotClearStore } from "@/stores/settings/local-snapshot-clear-store";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, snapshotsMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";

const SNAPSHOTS_LOCAL_STORAGE_PARAMS = {};

interface ClearLocalSnapshotsMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/** The host's saved Undo snapshots and the one confirmed clear for them. */
export function HostFileEditSnapshotsSection(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string | null;
  readonly hostName: string;
  readonly enabled: boolean;
}): ReactNode {
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.fileEditSnapshotsGroup}
      showTitle={false}
      tone="default"
      dataTestId="host-file-edit-snapshots"
      fill={false}
    >
      <ClearFileEditSnapshotsRow
        key={props.hostId}
        client={props.client}
        hostLabel={props.hostName}
        enabled={props.enabled}
      />
    </SettingsGroup>
  );
}

function ClearFileEditSnapshotsRow(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostLabel: string;
  readonly enabled: boolean;
}): ReactNode {
  // The keyed row remounts on a host switch. A confirmation armed against one
  // machine cannot survive to be retargeted at another.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? state.profile?.userId ?? null,
  );
  const { client, hostLabel } = props;

  const storageSizeQuery = useHostQuery<
    HostRpcRegistry,
    "snapshots.getLocalStorageSize"
  >({
    cacheKeyIdentity: undefined,
    client,
    method: "snapshots.getLocalStorageSize",
    params: SNAPSHOTS_LOCAL_STORAGE_PARAMS,
    options: null,
  });

  const clearSnapshotsMutation = useHostMutation<
    HostRpcRegistry,
    "snapshots.clearLocalSnapshots",
    ClearLocalSnapshotsMutationContext
  >({
    client,
    method: "snapshots.clearLocalSnapshots",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: snapshotsMutationKeys.clearLocalSnapshots(),
      onMutate: () => ({
        hostId: client === null ? null : client.getActiveHostId(),
        userId: currentUserId,
      }),
      onSuccess: (result, _variables, context) => {
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.method<
              HostRpcRegistry,
              "snapshots.getLocalStorageSize"
            >(
              context.hostId,
              "snapshots.getLocalStorageSize",
              SNAPSHOTS_LOCAL_STORAGE_PARAMS,
            ),
          });
        }
        if (context.hostId !== null && context.userId !== null) {
          useLocalSnapshotClearStore
            .getState()
            .markCleared(context.userId, context.hostId, Date.now());
        }
        setConfirmOpen(false);
        toast.success("Cleared file edit snapshots", {
          description: `${formatSnapshotBytes(result.clearedBytes)} removed.`,
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't clear file edit snapshots."),
    },
  });

  return (
    <>
      <SettingsRow
        row={HOST_OVERVIEW.definitions.fileEditSnapshots}
        status={`Pre-edit file snapshots for Undo, and cached long plan content, stored on ${hostLabel}. This data stays on that host and is never synced.`}
        control={
          <div className="flex flex-col items-end gap-2">
            <div
              className="font-mono text-code-xs text-muted-foreground"
              data-testid="settings-local-snapshots-size"
            >
              <SnapshotsSize query={storageSizeQuery} />
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={
                !props.enabled ||
                client === null ||
                clearSnapshotsMutation.isPending
              }
              data-testid="settings-clear-file-edit-snapshots"
              onClick={() => {
                setConfirmOpen(true);
              }}
            >
              {clearSnapshotsMutation.isPending ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="settings-clear-file-edit-snapshots-spinner"
                  variant={undefined}
                />
              ) : null}
              Clear snapshots…
            </Button>
          </div>
        }
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={props.enabled ? confirmOpen : false}
        onOpenChange={setConfirmOpen}
        title={`Clear file edit snapshots on ${hostLabel}?`}
        description={`Cleared snapshots on ${hostLabel} cannot be restored. Conversation history and checkpoint records stay visible, but Undo is disabled for past turns on that host.`}
        cascadeSummary={null}
        actionLabel="Clear snapshots"
        isPending={clearSnapshotsMutation.isPending}
        onConfirm={() => {
          if (!props.enabled || client === null) return;
          clearSnapshotsMutation.mutate(SNAPSHOTS_LOCAL_STORAGE_PARAMS);
        }}
      />
    </>
  );
}

function SnapshotsSize(props: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly data: { readonly bytes: number } | undefined;
  };
}): ReactNode {
  const { query } = props;
  if (query.isPending) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <AgentSpinningDots
          className={undefined}
          testId="settings-local-snapshots-size-spinner"
          variant={undefined}
          tone="muted"
        />
        Calculating
      </span>
    );
  }
  if (query.isError) return "Unavailable";
  return formatSnapshotBytes(query.data?.bytes ?? 0);
}

function formatSnapshotBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const precision =
    exponent === 0 || value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[exponent] ?? "TB"}`;
}
