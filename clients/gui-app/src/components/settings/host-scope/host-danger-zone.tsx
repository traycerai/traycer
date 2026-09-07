import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostQuery, useHostMutation } from "@/hooks/host/use-host-query";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDeregisterHostFromAccount } from "@/hooks/auth/use-deregister-host-mutation";
import { useRunnerUninstallTraycer } from "@/hooks/runner/use-runner-uninstall-traycer-mutation";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLocalSnapshotClearStore } from "@/stores/settings/local-snapshot-clear-store";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, snapshotsMutationKeys } from "@/lib/query-keys";
import type { HostRpcRegistry } from "@/lib/host";
import {
  HostScopeConnecting,
  HostScopeGate,
} from "@/components/settings/host-scope/host-scope-gate";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

const SNAPSHOTS_LOCAL_STORAGE_PARAMS = {};

interface ClearLocalSnapshotsMutationContext {
  readonly hostId: string | null;
  readonly userId: string | null;
}

/** Splitting by scope is the fix: what belongs to a host lives on that host's page, where the page title
 * already names the target; "Clear local app state" is genuinely app-global and stays behind in General. */
export function HostDangerZone(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  if (scope.host === null) return null;
  // Gating it too took the only way to remove a broken install out of the app that installed it, in the one
  // state anyone wants it.
  return (
    <SettingsGroup
      title="Danger zone"
      tone="danger"
      dataTestId="host-danger-zone"
      fill={false}
    >
      <HostScopeGate
        scope={scope}
        skeleton={<HostScopeConnecting hostName={scope.hostLabel} />}
      >
        <ClearFileEditSnapshotsRow scope={scope} />
      </HostScopeGate>
      {/* So it is outside the gate for the same reason "Remove Traycer" is - it needs no route, and a host you cannot
         reach is a common reason to want it gone. */}
      <HostRemovalRow host={scope.host} />
    </SettingsGroup>
  );
}

/** Offering both would put two destructive buttons side by side whose difference only becomes visible
 * afterwards. */
function HostRemovalRow(props: { readonly host: HostScopeOption }): ReactNode {
  const { host } = props;
  if (host.isLocalMachine) return <RemoveTraycerRow />;
  if (!host.registered) return null;
  // Passing the new id into the same instance would leave an already-open confirmation - and the mutation's own
  // `isPending` - pointing at whichever host the page moved to.
  return (
    <RemoveFromAccountRow
      key={host.hostId}
      hostId={host.hostId}
      hostName={host.name}
    />
  );
}

/** Signing in again on that machine does not help either, and the copy must not suggest it: the interactive
 * login path sits below the same early return. */
function RemoveFromAccountRow(props: {
  readonly hostId: string;
  readonly hostName: string;
}): ReactNode {
  const { hostId, hostName } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Closing over `hostId` is not by itself what stops a scope change from retargeting an open confirmation - a
  // re-render with a new prop rebuilds these closures around the new id while `confirmOpen` survives.
  const removeFromAccount = useDeregisterHostFromAccount(hostId);

  return (
    <>
      <SettingsRow
        label="Remove from account"
        description={`Removes ${hostName} from this account's host list and drops its presence. Nothing is uninstalled and no data is deleted.`}
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={removeFromAccount.isPending}
            data-testid="settings-remove-host-from-account"
            onClick={() => setConfirmOpen(true)}
          >
            {removeFromAccount.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="settings-remove-host-from-account-spinner"
                variant={undefined}
              />
            ) : null}
            Remove from account
          </Button>
        }
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Remove ${hostName} from this account?`}
        description={`${hostName} stops appearing in your host list and stops reporting presence. Nothing on that machine changes - Traycer stays installed and no agents, history or credentials are deleted. It won't rejoin on its own, and signing in on that machine again won't bring it back: it has to be set up again there. Its host ID is kept, so setting it up again restores the same name and settings.`}
        cascadeSummary={null}
        actionLabel="Remove from account"
        isPending={removeFromAccount.isPending}
        onConfirm={() => {
          removeFromAccount.mutate(undefined, {
            onSuccess: () => {
              setConfirmOpen(false);
              toast.success(`Removed ${hostName} from this account`);
            },
          });
        }}
      />
    </>
  );
}

function ClearFileEditSnapshotsRow(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  // A confirmation armed against one machine cannot survive to be retargeted at another.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();
  const currentUserId = useAuthStore(
    (state) => state.contextMetadata?.userId ?? state.profile?.userId ?? null,
  );
  const hostLabel = scope.hostLabel;
  const client = scope.client;

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
        label="File edit snapshots"
        description={`Pre-edit file snapshots for Undo, and cached long plan content, stored on ${hostLabel}. This data stays on that host and is never synced.`}
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
              disabled={client === null || clearSnapshotsMutation.isPending}
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
              Clear snapshots
            </Button>
          </div>
        }
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Clear file edit snapshots on ${hostLabel}?`}
        description={`Cleared snapshots on ${hostLabel} cannot be restored. Conversation history and checkpoint records stay visible, but Undo is disabled for past turns on that host.`}
        cascadeSummary={null}
        actionLabel="Clear snapshots"
        isPending={clearSnapshotsMutation.isPending}
        onConfirm={() => {
          if (client === null) return;
          clearSnapshotsMutation.mutate(SNAPSHOTS_LOCAL_STORAGE_PARAMS);
        }}
      />
    </>
  );
}

/** "No host row" therefore must not be read as "nothing to remove": enrollment and installation are different
 * facts, and removal runs over the local CLI bridge, which needs no row. */
export function LocalRecoveryDangerZone(): ReactNode {
  const { hostManagement } = useRunnerHost();
  if (hostManagement === null) return null;
  return (
    <SettingsGroup
      title="Danger zone"
      tone="danger"
      dataTestId="host-danger-zone"
      fill={false}
    >
      <RemoveTraycerRow />
    </SettingsGroup>
  );
}

/** Uninstalling the host is the most host-scoped action there is, so it lives on the host's own page rather
 * than beside app-global resets in General. Local host only - there is no remote uninstall verb. */
function RemoveTraycerRow(): ReactNode {
  const { hostManagement } = useRunnerHost();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const uninstall = useRunnerUninstallTraycer();
  if (hostManagement === null) return null;

  if (uninstall.isSuccess) {
    if (uninstall.data.serviceRegistrationRetained === true) {
      return (
        <SettingsRow
          label="Traycer removal incomplete"
          description="The background service is still registered. Traycer has not been fully removed; try again before quitting the app."
          control={
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-testid="settings-retry-uninstall"
              onClick={() => uninstall.mutate()}
            >
              Try again
            </Button>
          }
        />
      );
    }
    if (uninstall.data.serviceRegistrationRetained === null) {
      return (
        <SettingsRow
          label="Traycer removal unverified"
          description="The removal commands finished, but Traycer could not verify whether the background service remains registered. Run traycer host service status in a terminal and resolve any remaining service before quitting the app."
          control={
            <span className="text-muted-foreground text-xs">
              Check terminal
            </span>
          }
        />
      );
    }
    return (
      <SettingsRow
        label="Traycer removed"
        description="Background components were removed. Your agents, history and credentials are preserved on this computer. To finish, quit Traycer and drag it from Applications to the Trash."
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="settings-quit-after-uninstall"
            onClick={() => requestAppQuit()}
          >
            Quit Traycer
          </Button>
        }
      />
    );
  }

  return (
    <>
      <SettingsRow
        label="Remove Traycer from this computer"
        description="Stops the background host and services and removes the installed components. Your agents and history are preserved, and the host won't reinstall itself."
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={uninstall.isPending}
            data-testid="settings-remove-traycer"
            onClick={() => setConfirmOpen(true)}
          >
            {uninstall.isPending ? (
              <AgentSpinningDots
                className={undefined}
                testId="settings-remove-traycer-spinner"
                variant={undefined}
              />
            ) : null}
            Remove Traycer
          </Button>
        }
      />
      <ConfirmDestructiveDialog
        blockedReason={null}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Remove Traycer from this computer?"
        description="This stops and removes Traycer's background host and services and won't reinstall them automatically. Your agents, history and credentials stay on this computer - you can reinstall anytime from Settings."
        cascadeSummary={null}
        actionLabel="Remove Traycer"
        isPending={uninstall.isPending}
        onConfirm={() => {
          uninstall.mutate(undefined, {
            onSuccess: () => setConfirmOpen(false),
          });
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
          className="text-muted-foreground"
          testId="settings-local-snapshots-size-spinner"
          variant={undefined}
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
