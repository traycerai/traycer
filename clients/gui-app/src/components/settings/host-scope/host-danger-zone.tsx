import { useId, useState, type ReactNode } from "react";
import type { TraycerRemoved } from "@traycer-clients/shared/platform/runner-host";
import { toast } from "sonner";
import { HOST_OVERVIEW } from "@/components/settings/panels/host-overview.definitions";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useRunnerHost } from "@/providers/use-runner-host";
import { useDeregisterHostFromAccount } from "@/hooks/auth/use-deregister-host-mutation";
import { useRunnerUninstallTraycer } from "@/hooks/runner/use-runner-uninstall-traycer-mutation";
import { useLocalHostForegroundRun } from "@/hooks/host/use-local-host-foreground-run";
import { HOST_FOREGROUND_REMOVE_TRAYCER_REASON } from "@/lib/host/host-lifecycle-copy";
import { requestAppQuit } from "@/lib/desktop-app-lifecycle";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import type { HostScopeOption } from "@/components/settings/host-scope/host-scope-model";

/**
 * Destructive actions that belong to a MACHINE.
 *
 * These used to sit in General → Danger Zone, in one red box with "Clear local
 * app state" — three rows at three different scopes, one of which carried its
 * own host dropdown so that a destructive button took its target from a
 * control styled like a form field. Splitting by scope is the fix: what
 * belongs to a host lives on that host's page, where the page title
 * already names the target; "Clear local app state" is genuinely app-global
 * and stays behind in General.
 */
export function HostDangerZone(props: {
  readonly scope: HostScope;
}): ReactNode {
  const { scope } = props;
  const { hostManagement } = useRunnerHost();
  if (scope.host === null) return null;
  if (scope.host.isLocalMachine && hostManagement === null) return null;
  if (!scope.host.isLocalMachine && !scope.host.registered) return null;
  // Both removal paths stay available when the host cannot answer RPCs.
  // Local uninstall uses the CLI bridge; remote account removal writes to the
  // account. File edit snapshots are host RPC and now live in the Data tab.
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.dangerZone}
      showTitle
      tone="danger"
      dataTestId="host-danger-zone"
      fill={false}
    >
      <HostRemovalRow host={scope.host} onRemoved={scope.returnToActive} />
    </SettingsGroup>
  );
}

/**
 * Whichever removal verb this host actually has.
 *
 * They are not two versions of one action. "Remove Traycer" uninstalls
 * components from THIS computer over the CLI bridge; "Remove from account" ends
 * a host's membership of the account and changes nothing on its machine.
 * Offering both would put two destructive buttons side by side whose difference
 * only becomes visible afterwards.
 *
 * Account removal is registered-only: a directory-only host has no membership to
 * end, so the row would be a destructive control with nothing behind it.
 *
 * A sandbox is never removed here: its membership follows its lifecycle, and
 * the account refuses the removal. The row keeps its label, so a search for
 * "remove" still lands on it, and says where the sandbox is removed instead.
 */
function HostRemovalRow(props: {
  readonly host: HostScopeOption;
  readonly onRemoved: () => void;
}): ReactNode {
  const { host } = props;
  if (host.isLocalMachine) return <RemoveTraycerRow />;
  if (!host.registered) return null;
  if (host.sandbox !== null) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removeFromAccount}
        status={
          <span data-testid="settings-remove-host-sandbox-managed">
            Managed from its sandbox card.
          </span>
        }
        control={null}
      />
    );
  }
  // Keyed by host id so a scope change REMOUNTS the row. Passing the new id
  // into the same instance would leave an already-open confirmation - and the
  // mutation's own `isPending` - pointing at whichever host the page moved to.
  return (
    <RemoveFromAccountRow
      key={host.hostId}
      hostId={host.hostId}
      hostName={host.name}
      onRemoved={props.onRemoved}
    />
  );
}

/**
 * "Remove from account" — the remote danger-zone verb.
 *
 * NEVER the word "deregister" in copy, and the collision is not hypothetical:
 * this app already says "Deregister" for OS-SERVICE deregistration in the
 * Installation group just above, on the same tab, which is a machine-local
 * repair operation with nothing in common with this one.
 *
 * The copy is written against what `POST /api/v3/hosts/:hostId/deregister`
 * actually does. It stamps `deregisteredAt` and clears the presence lease; it
 * does not revoke, does not touch the machine, and keeps the `hostId`.
 *
 * What happens to a host that is STILL RUNNING was got wrong once here, in the
 * optimistic direction, so it is traced rather than assumed. Its next heartbeat
 * 404s and it reads that as `not-registered`, which drops it to unprovisioned
 * and re-runs `reconcile()` — but reconcile finds the on-box device credential
 * still present and still matching this host id, so it takes
 * `adoptActiveCredential()` and RETURNS, before either enrollment source. It
 * never calls `registerHost()`, which is the only thing that would clear
 * `deregisteredAt`. The host therefore loops (adopt → beat → 404 → adopt) and
 * does not rejoin on its own.
 *
 * Signing in again on that machine does not help either, and the copy must not
 * suggest it: the interactive login path sits BELOW the same early return, so a
 * fresh `traycer login` is never consulted while a matching credential file
 * exists. Coming back requires the host to be set up again on that machine —
 * and because the row is deregistered rather than revoked, a re-enrollment
 * re-adopts the SAME id with its policy preserved.
 *
 * A successful removal hands the page back to the active host (`onRemoved`).
 * Otherwise Settings stays pinned to the id just removed, and the next list
 * refresh resolves that pin to the `vanished` notice - "<uuid> is no longer
 * registered" - for a removal the user confirmed seconds ago. That notice is
 * for a host that disappears out from under the page; here the user asked for
 * the removal and the toast names it, so following the active host again is
 * not the silent retarget `resolveScopedHost` refuses.
 */
function RemoveFromAccountRow(props: {
  readonly hostId: string;
  readonly hostName: string;
  readonly onRemoved: () => void;
}): ReactNode {
  const { hostId, hostName, onRemoved } = props;
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Closing over `hostId` is NOT by itself what stops a scope change from
  // retargeting an open confirmation - a re-render with a new prop rebuilds
  // these closures around the new id while `confirmOpen` survives. The remount
  // key at this component's one call site is what makes that safe.
  const removeFromAccount = useDeregisterHostFromAccount(hostId);

  return (
    <>
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removeFromAccount}
        status={`Removes ${hostName} from this account's host list and drops its presence. Nothing is uninstalled and no data is deleted.`}
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
              // Last: it moves the scope, which remounts this row's page.
              onRemoved();
            },
          });
        }}
      />
    </>
  );
}

/**
 * The empty-account recovery variant: no host ROW exists, but installed
 * components can — an install that completed while sign-in did not leaves
 * exactly that state, and this page is the only uninstall surface (General's
 * was deliberately removed). "No host row" therefore must not be read as
 * "nothing to remove": enrollment and installation are different facts, and
 * removal runs over the local CLI bridge, which needs no row. Renders the
 * local row alone — with no host there is no RPC row to gate — and returns
 * nothing without the bridge so the danger group never renders empty. The
 * caller decides whether anything is actually installed; this component
 * cannot know.
 */
export function LocalRecoveryDangerZone(): ReactNode {
  const { hostManagement } = useRunnerHost();
  if (hostManagement === null) return null;
  return (
    <SettingsGroup
      group={HOST_OVERVIEW.definitions.dangerZone}
      showTitle
      tone="danger"
      dataTestId="host-danger-zone"
      fill={false}
    >
      <RemoveTraycerRow />
    </SettingsGroup>
  );
}

interface RemovedTraycerStatusProps {
  readonly removed: TraycerRemoved;
  readonly blockedReason: string | null;
  readonly reasonId: string;
  readonly onRetry: () => void;
}

function RemovedTraycerStatus(props: RemovedTraycerStatusProps): ReactNode {
  const { removed, blockedReason, reasonId } = props;
  const reasonHint =
    blockedReason === null ? undefined : (
      <span id={reasonId}>{blockedReason}</span>
    );
  // The host's Scheduled Task is not this account's (another Windows user's,
  // or one whose owner could not be confirmed - main's copy says which): the
  // removal left it alone on purpose and removed everything of this
  // account's, so there is nothing to try again. Say so on the finished row.
  if (removed.serviceWarning !== null) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removed}
        hint={
          <span data-testid="settings-remove-traycer-service-warning">
            {removed.serviceWarning}
          </span>
        }
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
  if (removed.serviceRegistrationRetained === true) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removalIncomplete}
        hint={reasonHint}
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={blockedReason !== null}
            aria-describedby={blockedReason === null ? undefined : reasonId}
            data-testid="settings-retry-uninstall"
            onClick={props.onRetry}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (removed.serviceRegistrationRetained === null) {
    return (
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removalUnverified}
        control={
          <span className="text-muted-foreground text-xs">Check terminal</span>
        }
      />
    );
  }
  return (
    <SettingsRow
      row={HOST_OVERVIEW.definitions.removed}
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

/**
 * Uninstalling the host is the most host-scoped action there is, so it lives
 * on the host's own page rather than beside app-global resets in General.
 * Local host only — there is no remote uninstall verb.
 */
function RemoveTraycerRow(): ReactNode {
  const { hostManagement } = useRunnerHost();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const uninstall = useRunnerUninstallTraycer();
  // THIS machine's host was started in a terminal: removing Traycer would stop
  // a run this app did not start, and the CLI refuses it. Withheld with the
  // reason on every control that removes - the row's button, its confirm (a
  // run that began under an open dialog) and the incomplete state's retry.
  const blockedReason = useLocalHostForegroundRun()
    ? HOST_FOREGROUND_REMOVE_TRAYCER_REASON
    : null;
  const reasonId = useId();
  if (hostManagement === null) return null;
  const reasonHint =
    blockedReason === null ? undefined : (
      <span id={reasonId}>{blockedReason}</span>
    );

  // Only a removal that RAN switches the row. A `declined` one removed
  // nothing, so the row stays on Remove Traycer and the hook's notice says why.
  const removed =
    uninstall.isSuccess && uninstall.data.kind === "removed"
      ? uninstall.data
      : null;
  if (removed !== null) {
    return (
      <RemovedTraycerStatus
        removed={removed}
        blockedReason={blockedReason}
        reasonId={reasonId}
        onRetry={() => uninstall.mutate()}
      />
    );
  }

  return (
    <>
      <SettingsRow
        row={HOST_OVERVIEW.definitions.removeTraycer}
        hint={reasonHint}
        control={
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={uninstall.isPending || blockedReason !== null}
            aria-describedby={blockedReason === null ? undefined : reasonId}
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
        blockedReason={blockedReason}
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
