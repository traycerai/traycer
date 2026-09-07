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
import {
  busyRestartMessage,
  HOST_CHANGED_DESCRIPTION,
} from "@/components/host/host-restart-copy";
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

/** The binding is load-bearing rather than informational: the force leg respawns whatever local host exists
 * when it runs, so an offer must never be acted on once it stops describing that process. */
interface ForceOffer {
  readonly hostId: string;
  readonly message: string;
}

/** One armed restart claim. Keyed by host because a `transitionId` names a claim granted by a single host
 * process - reusing it against a different one asks that host to adopt a transition it never started. */
interface ArmedRestartId {
  readonly hostId: string;
  readonly transitionId: string;
}

/** The directory query deliberately retains its previous data across a refetch (so consumers never flash a
 * loading state), which means it can still be serving the previous local id in that window. */
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

/** `useHostClientForHostId` also answers `null` when the renderer has no authenticated request context (signed
 * out, or the credential lease was released), and that must never read as absence. */
function looksDialable(entry: HostDirectoryEntry | null): boolean {
  return (
    entry !== null &&
    entry.websocketUrl !== null &&
    entry.transportDialability === "dialable"
  );
}

type ConfirmAction = "host-changed" | "cooperative" | "offer-force" | "force";

/** Ordering is the invariant: a host that changed under the dialog is refused before anything is dispatched; a
 * client we can ask is always asked. */
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

/** Whether a pending force offer has stopped describing the host it would kill, because this machine's local
 * host was replaced while the offer sat open. */
function isOfferStale(
  offer: ForceOffer | null,
  localHostId: string | null,
): boolean {
  return offer !== null && offer.hostId !== localHostId;
}

interface LocalHostRestartFlowProps {
  readonly requested: boolean;
  readonly onClose: () => void;
}

/** For the menu/tray surfaces this is most often the exact host state the restart action exists to fix - a hung
 * process whose handshake completed long ago. */
const UNANSWERED_RESTART_MESSAGE =
  "This host didn't complete the restart request. It may be stuck, still " +
  "starting up, or too old to stop cleanly on its own. Force restart kills " +
  "the host process and relaunches it.";

/** The process is alive and may be busy, so this is not the no-local-host case: the user gets the destructive
 * choice explicitly instead of the flow taking it on their behalf. */
const UNREACHABLE_CLIENT_MESSAGE =
  "Traycer couldn't open a connection to ask this host to stop cleanly - you " +
  "may be signed out, or its credentials may be refreshing. Force restart " +
  "kills the host process and relaunches it, ending whatever it is running.";

/** `onRestarted` fires only for a respawn the bridge actually performed. A `declined` result performed nothing,
 * so it deliberately does not fire and the id stays armed for a retry that may still need to adopt the claim. */
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
      // `declined` resolves (rather than rejecting) because it is not an error.
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

/** Split on the host-runtime binding because `useHostClientForHostId` - the one shared "which host does this id
 * resolve to" resolution. */
export function LocalHostRestartFlow(
  props: LocalHostRestartFlowProps,
): ReactNode {
  const binding = useHostBinding();
  if (binding === null) return <ForceOnlyRestartFlow {...props} />;
  return <CooperativeFirstRestartFlow {...props} />;
}

/** It exists because `useHostClientForHostId` throws without that provider, and a surface that force-restarts
 * must not be the thing that crashes the root. */
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

/** A host that merely looks unsupported is still asked; what a cached manifest claims about it is never allowed
 * to authorize the kill (see `cooperativeClient` below). */
function CooperativeFirstRestartFlow(
  props: LocalHostRestartFlowProps,
): ReactNode {
  const binding = useHostBinding();
  const directoryQuery = useHostDirectoryList();
  // `resolveLocalEntry`'s fallback scans `directoryQuery.data` for `kind === "local"`, and the merged snapshot's
  // only local row IS `getLocalEntry`'s.
  const localEntry = resolveLocalEntry(
    binding === null ? null : binding.directory.getLocalEntry(),
    directoryQuery.data,
  );
  const localHostId = localEntry === null ? null : localEntry.hostId;
  const client = useHostClientForHostId(localHostId);
  // `useHostClientForHostId(null)` follows the app-wide default host, which is exactly the client this flow must
  // never dispatch against - hence the id-null guard rides with the client, not just with the dispatch.
  const cooperativeClient = localHostId !== null ? client : null;
  const restart = useHostRestart(cooperativeClient);

  // It carries the host id it describes, because `requestHostRespawn` is not host-scoped - it respawns whichever
  // local host this machine has at the moment it is called.
  const [forceOffer, setForceOffer] = useState<ForceOffer | null>(null);
  // A dismissed-mid-flight cooperative attempt settles after close and parks its verdict here, where the next
  // invocation would render it as a stale force offer that skipped confirm.
  const [prevRequested, setPrevRequested] = useState(props.requested);
  if (prevRequested !== props.requested) {
    setPrevRequested(props.requested);
    if (props.requested) setForceOffer(null);
  }
  // Drop it and fall back to the confirm step, which re-asks the new host cooperatively instead of presenting
  // the old one's verdict over a kill.
  if (isOfferStale(forceOffer, localHostId)) {
    setForceOffer(null);
  }
  // The claim-adoption contract `host.restart` documents: minted when the action is armed, reused for a retry
  // after an ambiguous transport failure (the host may already hold the claim under it).
  const armedRestartIdRef = useRef<ArmedRestartId | null>(null);

  const close = (): void => {
    setForceOffer(null);
    props.onClose();
  };
  // Both click handlers re-read the live local host rather than trusting the rendered value.
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
  // Cache-derived rather than observer-derived: menu, tray and Settings all submit respawns under this key, and
  // each surface's own observer only sees its own dispatches.
  const respawnInFlight =
    useIsMutating({ mutationKey: runnerMutationKeys.hostRestart() }) > 0;

  const dispatchCooperative = (hostId: string): void => {
    // Adopt the armed id only when it was minted against this host; a different host means a different
    // claim-granting process, so that id is spent as far as this dispatch is concerned.
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
          // A definitive answer ends this action: accepted means the claim is spent, busy means it was refused outright.
          // Either way the next confirm is a new action and must not adopt this id.
          armedRestartIdRef.current = null;
          if (response.outcome === "busy") {
            setForceOffer({
              hostId,
              // Always `true` on this arm: the offer IS the dialog this sets,
              // and its Force button is the control the sentence promises.
              message: busyRestartMessage(response.verdict, true),
            });
            return;
          }
          close();
          announceRestartRequested();
        },
        onError: () => {
          // Deliberately not cleared: a transport failure says nothing about whether the host granted the claim, so the
          // id stays armed for the retry that adopts it.
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
