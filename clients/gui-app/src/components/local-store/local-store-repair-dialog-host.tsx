import { useState } from "react";
import { toast } from "sonner";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useLocalStoreRebindMutation } from "@/hooks/local-store/use-local-store-rebind-mutation";
import {
  closeLocalStoreRepair,
  useLocalStoreRepairStore,
  type LocalStoreRepairRequest,
} from "@/stores/local-store/local-store-repair-store";

/**
 * The repair route for a create the host refused because its local store would
 * not open.
 *
 * Mounted app-wide rather than inside the composer, and that is the point.
 * Before this, `useLocalStoreRebindMutation`'s only consumer was
 * `SnapshotErrorBanner`, reached by OPENING an epic that fails to load - so a
 * user whose store is refused, with no local-homed epic to open, could not
 * reach the repair at all. A create refusal is exactly that population: they
 * were trying to make their first epic.
 *
 * The refusal arrives as DATA on `epic.create@1.1`, in a mutation callback with
 * no component context, which is why the handoff is a store
 * (`local-store-repair-store.ts`) and not a prop.
 */
export function LocalStoreRepairDialogHost(): React.ReactNode {
  const pending = useLocalStoreRepairStore((state) => state.pending);
  if (pending === null) return null;
  // Keyed by host so a second refusal on a DIFFERENT machine remounts rather
  // than reusing the first host's negotiated gate and mutation.
  return <LocalStoreRepairDialog key={pending.hostId} request={pending} />;
}

function LocalStoreRepairDialog(props: {
  readonly request: LocalStoreRepairRequest;
}): React.ReactNode {
  const { hostId, refusal } = props.request;
  const rebindLocalStore = useLocalStoreRebindMutation(hostId);
  // Gated on THIS host's manifest, not the window's. `host.rebindLocalStore`
  // is an optional unary, so an older host emits the refusal and still cannot
  // serve the repair; offering it there ends in an unsupported-RPC toast with
  // no recovery behind it. Fails closed - an unknown manifest reads as absent.
  const rebindSupported = useHostSupportsMethod(
    hostId,
    "host.rebindLocalStore",
  );
  // The rebind is offered on host support alone, because `refusal.kind` has
  // exactly one member today and a comparison against it is dead.
  //
  // This previously read `rebindSupported && refusal.kind ===
  // "local-store-unavailable"`, with a comment reasoning about "a kind this
  // build does not recognise". No such value can arrive:
  // `epicCreateRefusalKindSchema` is `z.enum(["local-store-unavailable"])`, so
  // an unrecognised kind fails the PARSE and never reaches this component -
  // the schema's own note says adding a kind costs a minor precisely because
  // every `@1.1` client rejects a new value.
  //
  // So the guard is reinstated by the same change that makes it meaningful:
  // adding a second kind is a minor bump, and whoever spends it has to decide
  // per kind whether a rebind is the remedy (the schema suggests an
  // `isKnownEpicCreateRefusalKind` guard for the degrade-to-text shape). Until
  // then this must not pretend to discriminate a union of one.
  //
  // Unchanged either way: the message and remedy TEXT renders for whatever
  // arrives, since both are strings the host wrote for a person.
  const repairable = rebindSupported;
  const [repairRefusal, setRepairRefusal] = useState<{
    readonly message: string;
    readonly remedy: string;
  } | null>(null);
  const shownRemedy = repairRefusal?.remedy ?? refusal.remedy;
  return (
    <ConfirmDestructiveDialog
      // Open for as long as a request is pending: the host above renders
      // nothing without one, so closing IS clearing the request. Keeping a
      // second `open` boolean beside the store would be two sources for one
      // piece of state, and they drift the first time one is set without the
      // other.
      open
      onOpenChange={(open) => {
        if (!open) closeLocalStoreRepair();
      }}
      title="Couldn't create the epic"
      description={`${repairRefusal?.message ?? refusal.message} ${shownRemedy}`}
      cascadeSummary={
        repairable
          ? "Rebinding claims this data directory for this host. Confirm that no other Traycer host is using it — rebinding while another host is writing could put your local data at risk."
          : null
      }
      blockedReason={
        repairable
          ? null
          : "This host can't repair its own store from here. Follow the steps above on the machine itself."
      }
      actionLabel="Rebind local store"
      isPending={
        rebindLocalStore.isPending || rebindLocalStore.isHostEntryPending
      }
      onConfirm={() => {
        rebindLocalStore.mutate(
          { confirmOldHostStopped: true },
          {
            onSuccess: (response) => {
              // `not-needed` is a SUCCESS - a healthy process-held store this
              // stale dialog asked to tear down. Same reading as
              // `SnapshotErrorBanner`: leaving the dialog open over a refusal
              // that no longer exists is the outcome the honest no-op exists
              // to avoid. Nothing is retried automatically; the user's next
              // create is the retry, and it will now succeed.
              if (
                response.status === "rebound" ||
                response.status === "not-needed"
              ) {
                closeLocalStoreRepair();
                toast.success(
                  "Local store repaired. Try creating the epic again.",
                );
                return;
              }
              // The repair itself was refused. Replace the create's refusal
              // with this one rather than stacking them - the rebind's reason
              // is the newer and more specific fact about the same store.
              setRepairRefusal({
                message: response.message,
                remedy: response.remedy,
              });
            },
          },
        );
      }}
    />
  );
}
