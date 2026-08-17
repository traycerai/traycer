import { useRef, useState, type ReactNode } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import type { HostRestartRequestResult } from "@traycer-clients/shared/platform/runner-host";
import { RestartHostConfirmDialog } from "@/components/host/restart-host-confirm-dialog";
import { HostBusyForceDeferDialog } from "@/components/host/host-busy-force-defer-dialog";
import { useHostRestart } from "@/components/settings/panels/host-overview-rpc";
import { newTransitionId } from "@/components/settings/panels/host-overview-transition-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostBinding } from "@/lib/host";
import {
  runnerMutationKeys,
  runnerQueryKeys,
} from "@/lib/query-keys/runner-mutation-keys";
import { toastHostRestartDeclined } from "@/lib/host-restart-toast";
import { toastFromRunnerError } from "@/lib/runner-error-toast";
import { useRunnerHost } from "@/providers/use-runner-host";

/**
 * A pending "force restart?" offer, bound to the host whose answer produced
 * it. The binding is load-bearing rather than informational: the force leg
 * respawns whatever local host exists when it runs, so an offer must never be
 * acted on once it stops describing that process.
 */
interface ForceOffer {
  readonly hostId: string;
  readonly message: string;
}

/**
 * One armed restart claim. Keyed by host because a `transitionId` names a
 * claim granted by a single host process - reusing it against a different one
 * asks that host to adopt a transition it never started.
 */
interface ArmedRestartId {
  readonly hostId: string;
  readonly transitionId: string;
}

/**
 * Which host id this machine's local host currently has, from the two sources
 * that answer it - each covering the other's blind spot.
 *
 * The LIVE entry wins. `HostDirectoryService` assigns it inside the
 * `onLocalHostChange` callback, so it is correct the instant this machine's
 * host identity changes. The directory query deliberately RETAINS its previous
 * data across a refetch (so consumers never flash a loading state), which means
 * it can still be serving the PREVIOUS local id in that window - and if that id
 * still resolves, dispatching there would ask one host to stand down while the
 * force leg kills another.
 *
 * The query is still needed: it keeps presenting this machine as a
 * `kind: "local"` entry while the host is DOWN, where the live snapshot is
 * `null` - the case a restart most needs to serve.
 */
function resolveLocalEntry(
  liveLocalEntry: HostDirectoryEntry | null,
  directoryEntries: readonly HostDirectoryEntry[] | undefined,
): HostDirectoryEntry | null {
  if (liveLocalEntry !== null) return liveLocalEntry;
  const fromDirectory = (directoryEntries ?? []).find(
    (entry) => entry.kind === "local",
  );
  return fromDirectory === undefined ? null : fromDirectory;
}

/**
 * Whether this host is one we should have been able to DIAL - which is what
 * separates "no local host to ask" from "we could not ask the one that is
 * there". `useHostClientForHostId` also answers `null` when the renderer has
 * no authenticated request context (signed out, or the credential lease was
 * released), and that must never read as absence: the process is alive and
 * possibly busy, we simply have no way to put the question to it.
 *
 * Reading `transportDialability` for a DIALING decision is its sanctioned use;
 * it is the reason field (`useHostReachability`) that user-facing copy wants.
 */
function looksDialable(entry: HostDirectoryEntry | null): boolean {
  return (
    entry !== null &&
    entry.websocketUrl !== null &&
    entry.transportDialability === "dialable"
  );
}

/** What a confirm click resolves to, from values re-read AT click time. */
type ConfirmAction = "host-changed" | "cooperative" | "offer-force" | "force";

/**
 * The confirm decision, as data rather than nested branches in the handler.
 *
 * Ordering is the invariant: a host that changed under the dialog is refused
 * before anything is dispatched; a client we can ask is always asked; a host
 * that looks reachable but has no client turns into an EXPLICIT force offer
 * rather than a silent kill; and only a host with no dialable route left falls
 * straight through to the respawn, which is how a stopped host comes back.
 */
function decideConfirmAction(
  liveHostId: string | null,
  localHostId: string | null,
  hasCooperativeClient: boolean,
  localHostLooksDialable: boolean,
): ConfirmAction {
  if (
    liveHostId !== null &&
    localHostId !== null &&
    liveHostId !== localHostId
  ) {
    return "host-changed";
  }
  if (hasCooperativeClient) return "cooperative";
  if (localHostLooksDialable) return "offer-force";
  return "force";
}

/**
 * Whether a pending force offer has stopped describing the host it would kill,
 * because this machine's local host was replaced while the offer sat open.
 */
function isOfferStale(
  offer: ForceOffer | null,
  localHostId: string | null,
): boolean {
  return offer !== null && offer.hostId !== localHostId;
}

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
 * The host is dialable but no client could be built for it - the renderer has
 * no authenticated request context (signed out, or a credential lease being
 * renewed). The process is alive and may be busy, so this is NOT the
 * no-local-host case: the user gets the destructive choice explicitly instead
 * of the flow taking it on their behalf.
 */
const UNREACHABLE_CLIENT_MESSAGE =
  "Traycer couldn't open a connection to ask this host to stop cleanly - you " +
  "may be signed out, or its credentials may be refreshing. Force restart " +
  "kills the host process and relaunches it, ending whatever it is running.";

/** Shown when the machine's host was replaced while a dialog was open. */
const HOST_CHANGED_DESCRIPTION =
  "This machine's host was replaced while this dialog was open, so nothing " +
  "was stopped. Restart again to check the new host.";

/**
 * The forced bridge respawn, shared by both arms of the flow.
 *
 * Under the SAME mutation key as the Settings force offer, so every
 * cache-derived restart gate (`useIsMutating` on this key) sees a menu/tray
 * initiated respawn too - the menu's old mutation ran under its own key and
 * was invisible to the Settings page-wide lifecycle gate.
 *
 * `onRestarted` fires only for a respawn the bridge actually performed. That
 * ENDS the logical restart action, which the caller's armed `transitionId`
 * outlives if nothing says so: the id is deliberately kept across an ambiguous
 * cooperative failure (see `dispatchCooperative`), and forcing after such a
 * failure is a definitive end - the process it named is gone. A `declined`
 * result performed nothing, so it deliberately does NOT fire and the id stays
 * armed for a retry that may still need to adopt the claim.
 */
function useForceHostRespawn(
  close: () => void,
  onRestarted: () => void,
): {
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
      onRestarted();
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
 * Split on the host-runtime binding because `useHostClientForHostId` - the one
 * shared "which host does this id resolve to" resolution - THROWS without a
 * mounted runtime, and a surface whose whole job is a safe restart must not be
 * the thing that crashes the root. The app renders its router beneath
 * `HostRuntimeProvider`, which shows a fallback rather than children until the
 * binding publishes, so the bound arm is the one production takes.
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
  // No armed transition id on this arm - it never mints one, because it never
  // reaches the cooperative RPC that a transition id identifies.
  const { forceRestart } = useForceHostRespawn(props.onClose, () => undefined);
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
 * directly only where there is no cooperative route to attempt at all - no
 * local host id resolves, so there is no client to dial. A host that merely
 * looks unsupported is still asked; what a cached manifest claims about it is
 * never allowed to authorize the kill (see `cooperativeClient` below).
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
  // `null` from BOTH sources (see `resolveLocalHostId`) is SETTLED, not "still
  // loading" - which is what makes falling back to force legitimate. The
  // ordering that guarantees it: `IRunnerHost.onLocalHostChange` fires
  // synchronously on subscribe with the current snapshot (or `null`),
  // `HostDirectoryService` assigns `localEntry` in that callback while
  // installing the subscription inside `start()`, and the runtime provider
  // awaits `directory.start()` before publishing the binding this component
  // renders under. So a real snapshot is in hand by the first render. If that
  // contract ever turns async, this read silently becomes "unknown" and the
  // force path turns back into the silent kill this flow exists to remove -
  // gate it then.
  const localEntry = resolveLocalEntry(
    binding === null ? null : binding.directory.getLocalEntry(),
    directoryQuery.data,
  );
  const localHostId = localEntry === null ? null : localEntry.hostId;
  const client = useHostClientForHostId(localHostId);
  // NO capability gate on this dispatch, deliberately - not even the tri-state
  // one. The negotiated-manifest registry answers from a host's LAST handshake
  // and is refreshed by traffic alone: it never evicts, so a `false` recorded
  // against an old host survives that host being upgraded in place until some
  // unrelated RPC happens to refresh it, and `null` only ever meant "nobody has
  // asked yet". Neither is current evidence about the process we are about to
  // kill, and the registry's own docs warn against parking a decision on a
  // recorded absence.
  //
  // The cooperative RPC is its own probe: dialing performs the handshake, so
  // attempting it is both the question and the answer. A host that has
  // `host.restart` runs it; one that genuinely lacks it rejects into the force
  // offer below. That costs a too-old host one round trip and one extra click,
  // and buys the guarantee that nothing is ever killed on a cached verdict.
  //
  // `useHostClientForHostId(null)` follows the app-wide default host, which
  // is exactly the client this flow must never dispatch against - hence the
  // id-null guard rides with the client, not just with the dispatch.
  const cooperativeClient = localHostId !== null ? client : null;
  const restart = useHostRestart(cooperativeClient);

  // Non-null once the cooperative attempt settled anything other than
  // "accepted". It carries the host id it describes, because
  // `requestHostRespawn()` is NOT host-scoped - it respawns whichever local
  // host this machine has at the moment it is called - so an offer that
  // outlives a local host identity change would put A's session count above a
  // button that kills B, whose claim was never asked and whose sessions were
  // never counted.
  const [forceOffer, setForceOffer] = useState<ForceOffer | null>(null);
  // A dismissed-mid-flight cooperative attempt settles AFTER close and parks
  // its verdict here, where the NEXT invocation would render it as a stale
  // force offer that skipped confirm. Reset on the closed→requested
  // transition so every invocation starts at the confirm step;
  // adjust-during-render (the same pattern the Settings restart confirm uses
  // for its stale-open window) so the reset lands in the opening commit.
  const [prevRequested, setPrevRequested] = useState(props.requested);
  if (prevRequested !== props.requested) {
    setPrevRequested(props.requested);
    if (props.requested) setForceOffer(null);
  }
  // Same discipline for the other way this offer goes stale: the host it
  // describes was replaced while it sat open. Drop it and fall back to the
  // confirm step, which re-asks the NEW host cooperatively instead of
  // presenting the old one's verdict over a kill.
  if (isOfferStale(forceOffer, localHostId)) {
    setForceOffer(null);
  }
  // The claim-adoption contract `host.restart` documents: minted when the
  // action is armed, REUSED for a retry after an ambiguous transport failure
  // (the host may already hold the claim under it), cleared on every
  // definitive answer so a genuinely new action never adopts a stale claim.
  //
  // Keyed by host id, because a claim is granted by ONE host: adopting an id
  // minted against A when dispatching to B is precisely the cross-transition
  // correlation the contract forbids. (Kept as a ref rather than reset during
  // render because writing `ref.current` while rendering is an error under the
  // React Compiler rules; the dispatch below re-mints on a host mismatch.)
  const armedRestartIdRef = useRef<ArmedRestartId | null>(null);

  const close = (): void => {
    setForceOffer(null);
    props.onClose();
  };
  // Both click handlers re-read the LIVE local host rather than trusting the
  // rendered value: a host identity change arrives as a store update, so a
  // click processed against the previous committed render would compare stale
  // against stale and sail through. `getLocalEntry()` is synchronous and
  // current at the instant of the click.
  const liveHostIdNow = (): string | null => {
    if (binding === null) return null;
    const entry = binding.directory.getLocalEntry();
    return entry === null ? null : entry.hostId;
  };
  const refuseForHostChange = (): void => {
    close();
    toast.info("Host changed", { description: HOST_CHANGED_DESCRIPTION });
  };
  const { forceRestart, announceRestartRequested } = useForceHostRespawn(
    close,
    () => {
      armedRestartIdRef.current = null;
    },
  );
  // Cache-derived rather than observer-derived: menu, tray and Settings all
  // submit respawns under this key, and each surface's own observer only sees
  // its own dispatches.
  const respawnInFlight =
    useIsMutating({ mutationKey: runnerMutationKeys.hostRestart() }) > 0;

  const dispatchCooperative = (hostId: string): void => {
    // Adopt the armed id only when it was minted against THIS host; a
    // different host means a different claim-granting process, so that id is
    // spent as far as this dispatch is concerned.
    const armed = armedRestartIdRef.current;
    const transitionId =
      armed !== null && armed.hostId === hostId
        ? armed.transitionId
        : newTransitionId();
    armedRestartIdRef.current = { hostId, transitionId };
    restart.mutate(
      { transitionId },
      {
        onSuccess: (response) => {
          // A definitive answer ends this action: accepted means the claim is
          // spent, busy means it was refused outright. Either way the next
          // confirm is a NEW action and must not adopt this id.
          armedRestartIdRef.current = null;
          if (response.outcome === "busy") {
            setForceOffer({
              hostId,
              message: busyRestartMessage(response.verdict.busySessionCount),
            });
            return;
          }
          close();
          announceRestartRequested();
        },
        onError: () => {
          // Deliberately NOT cleared: a transport failure says nothing about
          // whether the host granted the claim, so the id stays armed for the
          // retry that adopts it.
          setForceOffer({ hostId, message: UNANSWERED_RESTART_MESSAGE });
        },
      },
    );
  };

  const confirmOpen = props.requested && forceOffer === null;
  const busyOpen = props.requested && forceOffer !== null;
  return (
    <>
      <RestartHostConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        isPending={restart.isPending || forceRestart.isPending}
        onConfirm={() => {
          const action = decideConfirmAction(
            liveHostIdNow(),
            localHostId,
            cooperativeClient !== null,
            looksDialable(localEntry),
          );
          if (action === "host-changed") {
            refuseForHostChange();
            return;
          }
          if (action === "cooperative" && localHostId !== null) {
            dispatchCooperative(localHostId);
            return;
          }
          if (action === "offer-force" && localHostId !== null) {
            setForceOffer({
              hostId: localHostId,
              message: UNREACHABLE_CLIENT_MESSAGE,
            });
            return;
          }
          forceRestart.mutate();
        }}
      />
      <HostBusyForceDeferDialog
        open={busyOpen}
        message={forceOffer?.message ?? ""}
        isForcing={forceRestart.isPending || respawnInFlight}
        forceLabel="Force restart"
        onForce={() => {
          const liveHostId = liveHostIdNow();
          if (liveHostId !== null && isOfferStale(forceOffer, liveHostId)) {
            refuseForHostChange();
            return;
          }
          forceRestart.mutate();
        }}
        onDefer={close}
      />
    </>
  );
}
