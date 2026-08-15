import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostRestartRequestResult } from "@traycer-clients/shared/platform/runner-host";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { useHostRestart } from "@/components/settings/panels/host-overview-rpc";
import { newTransitionId } from "@/components/settings/panels/host-overview-transition-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostBinding } from "@/lib/host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

interface LocalHostRestartFlowProps {
  /** The surface's "Restart Host was invoked" state; the flow owns the rest. */
  readonly requested: boolean;
  /** Clears that state. Every path out of the flow funnels through this. */
  readonly onClose: () => void;
}

/**
 * Same copy the Settings Overview busy notice renders for the same verdict, so
 * "restart refused because busy" reads identically wherever it surfaces.
 */
function busyRestartMessage(busySessionCount: number): string {
  const sessions =
    busySessionCount === 1
      ? "1 session is"
      : `${busySessionCount} sessions are`;
  return `${sessions} still working on this host. Nothing was interrupted; try again when they finish. Force restart ends them immediately.`;
}

/**
 * The cooperative RPC failed rather than answering busy. For the menu/tray
 * surfaces this is most often the exact host state the restart action exists
 * to fix - a hung process whose handshake completed long ago - so the failure
 * must offer force rather than dead-ending in an error toast the user cannot
 * act on.
 */
const UNANSWERED_RESTART_MESSAGE =
  "This host didn't complete the restart request. It may be stuck, still " +
  "starting up, or too old to stop cleanly on its own. Force restart kills " +
  "the host process and relaunches it.";

/**
 * The forced bridge respawn, shared by both arms of the flow.
 *
 * Under the SAME mutation key as the Settings force offer, so every
 * cache-derived restart gate (`useIsMutating` on this key) sees a menu/tray
 * initiated respawn too - the menu's old mutation ran under its own key and
 * was invisible to the Settings page-wide lifecycle gate.
 */
function useForceHostRespawn(close: () => void): {
  readonly forceRestart: UseMutationResult<
    HostRestartRequestResult,
    Error,
    void
  >;
  readonly announceRestartRequested: () => void;
} {
  const runnerHost = useRunnerHost();
  const queryClient = useQueryClient();
  const announceRestartRequested = (): void => {
    toast.success("Host restart requested");
    const traycerCli = runnerHost.traycerCli;
    if (traycerCli !== null) {
      void queryClient.invalidateQueries({
        queryKey: runnerQueryKeys.traycerHostStatus(traycerCli),
      });
    }
    const management = runnerHost.hostManagement;
    if (management === null) return;
    // A respawn is an activation cycle: a staged version can come up live, so
    // the update-state reads must be refreshed alongside the installed record.
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostInstalledRecord(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostAvailableVersionsScope(management),
    });
    void queryClient.invalidateQueries({
      queryKey: runnerQueryKeys.hostRegistryUpdate(management),
    });
  };
  const forceRestart = useMutation<HostRestartRequestResult>({
    mutationKey: runnerMutationKeys.hostRestart(),
    mutationFn: () => runnerHost.requestHostRespawn(),
    onSuccess: (result) => {
      close();
      // `declined` resolves (rather than rejecting) because it is not an
      // error - even a forced respawn is deliberately not performed when the
      // host was removed by the user or another process holds the management
      // lock; see `toastHostRestartDeclined`.
      if (result.kind === "declined") {
        toastHostRestartDeclined(result.message);
        return;
      }
      announceRestartRequested();
    },
    onError: (err) => {
      close();
      toastFromRunnerError(err, "Couldn't restart host");
    },
  });
  return { forceRestart, announceRestartRequested };
}

/**
 * The menu/tray "Restart Host" flow: cooperative first, force only by explicit
 * choice.
 *
 * Both native surfaces used to confirm and then jump straight to the bridge
 * respawn - `host restart --force` - which silently destroyed the in-progress
 * work the CLI's cooperative claim exists to protect (the GUI was strictly
 * more destructive than the CLI). This flow gives them the shape Settings →
 * Overview already has: attempt the claim-gated `host.restart` RPC, and when
 * the host refuses because work is in flight, put the live session count in
 * front of the user with Force restart as the explicit, destructive choice.
 *
 * Target resolution is the LOCAL machine's host by construction, never the
 * app-wide active host (which can be a remote machine): the force leg is a
 * bridge respawn of THIS machine's host process, so the cooperative leg must
 * ask the same process the force leg would kill.
 *
 * Split on the host-runtime binding because the listeners that render this
 * flow mount outside every host gate, where no runtime may exist yet - and
 * `useHostClientForHostId` (the one shared "which host does this id resolve
 * to" resolution) requires one. No runtime also means no route to ask a
 * cooperative question over, so the fallback arm IS the correct semantics for
 * that state, not merely a crash guard.
 */
export function LocalHostRestartFlow(
  props: LocalHostRestartFlowProps,
): ReactNode {
  const binding = useHostBinding();
  if (binding === null) return <ForceOnlyRestartFlow {...props} />;
  return <CooperativeFirstRestartFlow {...props} />;
}

/**
 * Confirm → forced bridge respawn, exactly what both surfaces shipped before
 * this flow existed. Reached only when NO host runtime is mounted, so there is
 * no transport to ask a cooperative question over and no id to ask about.
 *
 * Not a claim that such a host has nothing to protect - it may be alive and
 * busy; we simply cannot ask it. In this tree the app mounts both listeners
 * under `HostRuntimeProvider`, which renders its fallback rather than children
 * until the binding publishes, so production does not reach this arm today.
 * It exists because `useHostClientForHostId` THROWS without that provider, and
 * a surface that force-restarts must not be the thing that crashes the root.
 */
function ForceOnlyRestartFlow(props: LocalHostRestartFlowProps): ReactNode {
  const { forceRestart } = useForceHostRespawn(props.onClose);
  return (
    <RestartHostConfirmDialog
      open={props.requested}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      isPending={forceRestart.isPending}
      onConfirm={() => forceRestart.mutate()}
    />
  );
}

/**
 * Fallback semantics (deliberate): confirm dispatches the bridge respawn
 * directly only where there is POSITIVELY no cooperative route - no local
 * directory entry resolves (no id, so no client to dial with), or the host's
 * last completed handshake proves it does not advertise `host.restart` (a
 * host too old for the cooperative RPC). "Not negotiated yet" is deliberately
 * NOT one of those cases; see `cooperativeSupport` below.
 *
 * No renderer-side gate against in-flight update/activate mutations, on
 * purpose: the host's claim machinery already refuses a restart whose
 * `transitionId` would cut into someone else's in-flight transition (that
 * refusal is the busy verdict this flow renders), and the desktop main
 * process serializes every bridge mutation - respawn included - in one lane.
 * A renderer gate would re-state guarantees those layers own.
 */
function CooperativeFirstRestartFlow(
  props: LocalHostRestartFlowProps,
): ReactNode {
  const binding = useHostBinding();
  const directoryQuery = useHostDirectoryList();
  // Same durable read `use-host-options` documents: the directory keeps
  // presenting this machine's id as a `kind: "local"` entry while the host is
  // down; `getLocalEntry()` is only the faster path to the same id.
  const localHostId = useMemo(() => {
    const fromDirectory = (directoryQuery.data ?? []).find(
      (entry) => entry.kind === "local",
    );
    if (fromDirectory !== undefined) return fromDirectory.hostId;
    return binding?.directory.getLocalEntry()?.hostId ?? null;
  }, [directoryQuery.data, binding]);
  const client = useHostClientForHostId(localHostId);
  // The TRI-STATE read, deliberately not the `useHostSupportsMethod` boolean:
  // that form collapses "no handshake with this host has completed yet" into
  // "does not have it". Fail-closed is right for HIDING an affordance and
  // wrong here - this decision force-kills live sessions, so reading unknown
  // as absent acts on a fact not yet in evidence. The window is real: the
  // manifest registry fills in from the first completed RPC to that host, so a
  // restart taken right after the runtime binds can land inside it.
  //
  // Unknown therefore ATTEMPTS the cooperative call, because the RPC's own
  // dial and `openAck` IS the negotiation this would otherwise be waiting on:
  // a host that has the method answers normally, and one that does not rejects
  // into the force offer below. Every branch ends in an answer or an explicit
  // choice; none of them ends in a silent kill.
  const cooperativeSupport = useHostMethodSupport(localHostId, "host.restart");
  // `useHostClientForHostId(null)` follows the app-wide default host, which
  // is exactly the client this flow must never dispatch against - hence the
  // id-null guard rides with the client, not just with the dispatch.
  const cooperativeClient =
    localHostId !== null && cooperativeSupport !== false ? client : null;
  const restart = useHostRestart(cooperativeClient);

  // Non-null once the cooperative attempt settled anything other than
  // "accepted"; the message is what the force-offer dialog shows.
  const [forceOfferMessage, setForceOfferMessage] = useState<string | null>(
    null,
  );
  // A dismissed-mid-flight cooperative attempt settles AFTER close and parks
  // its verdict here, where the NEXT invocation would render it as a stale
  // force offer that skipped confirm. Reset on the closed→requested
  // transition so every invocation starts at the confirm step;
  // adjust-during-render (the same pattern the Settings restart confirm uses
  // for its stale-open window) so the reset lands in the opening commit.
  const [prevRequested, setPrevRequested] = useState(props.requested);
  if (prevRequested !== props.requested) {
    setPrevRequested(props.requested);
    if (props.requested) setForceOfferMessage(null);
  }
  // The claim-adoption contract `host.restart` documents: minted when the
  // action is armed, REUSED for a retry after an ambiguous transport failure
  // (the host may already hold the claim under it), cleared on every
  // definitive answer so a genuinely new action never adopts a stale claim.
  const armedRestartIdRef = useRef<string | null>(null);

  const close = (): void => {
    setForceOfferMessage(null);
    props.onClose();
  };
  const { forceRestart, announceRestartRequested } = useForceHostRespawn(close);
  // Cache-derived rather than observer-derived: menu, tray and Settings all
  // submit respawns under this key, and each surface's own observer only sees
  // its own dispatches.
  const respawnInFlight =
    useIsMutating({ mutationKey: runnerMutationKeys.hostRestart() }) > 0;

  const dispatchCooperative = (): void => {
    const transitionId = armedRestartIdRef.current ?? newTransitionId();
    armedRestartIdRef.current = transitionId;
    restart.mutate(
      { transitionId },
      {
        onSuccess: (response) => {
          // A definitive answer ends this action: accepted means the claim is
          // spent, busy means it was refused outright. Either way the next
          // confirm is a NEW action and must not adopt this id.
          armedRestartIdRef.current = null;
          if (response.outcome === "busy") {
            setForceOfferMessage(
              busyRestartMessage(response.verdict.busySessionCount),
            );
            return;
          }
          close();
          announceRestartRequested();
        },
        onError: () => {
          // Deliberately NOT cleared: a transport failure says nothing about
          // whether the host granted the claim, so the id stays armed for the
          // retry that adopts it.
          setForceOfferMessage(UNANSWERED_RESTART_MESSAGE);
        },
      },
    );
  };

  const confirmOpen = props.requested && forceOfferMessage === null;
  const busyOpen = props.requested && forceOfferMessage !== null;
  return (
    <>
      <RestartHostConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        isPending={restart.isPending || forceRestart.isPending}
        onConfirm={() => {
          if (cooperativeClient !== null) {
            dispatchCooperative();
            return;
          }
          forceRestart.mutate();
        }}
      />
      <HostBusyForceDeferDialog
        open={busyOpen}
        message={forceOfferMessage ?? ""}
        isForcing={forceRestart.isPending || respawnInFlight}
        forceLabel="Force restart"
        onForce={() => forceRestart.mutate()}
        onDefer={close}
      />
    </>
  );
}
