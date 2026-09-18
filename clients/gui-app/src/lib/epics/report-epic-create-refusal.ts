import type {
  EpicCreateRefusal,
  EpicCreateRefusalV12,
} from "@traycer/protocol/host/epic/unary-schemas";
import { toast } from "sonner";

import { openLocalStoreRepair } from "@/stores/local-store/local-store-repair-store";

/**
 * Surface a refused create, with the host's own words.
 *
 * `message` and `remedy` are rendered VERBATIM. That is the whole point of the
 * typed arm: before it, the host flattened both into a thrown `RPC_ERROR`
 * string with the epic id and no delimiter, so this side could recover neither
 * and showed "Couldn't create epic." - which reads as a network or account
 * problem and sends people chasing the wrong thing. The schema constrains both
 * to non-empty strings a host wrote for a person, so passing them through is
 * now the honest rendering rather than the lossy one.
 *
 * `hostId` is the client the create was DISPATCHED on, captured in `onMutate`.
 * It is the machine whose store refused, and on a pinned composer it is not the
 * window's effective host - repairing the latter would rebind a healthy store,
 * report success, and leave the refusing one untouched.
 *
 * No `hostId` means no action, not a guessed one. The remedy still renders, and
 * it is a sentence the user can act on at the machine itself; an affordance
 * pointed at an unknown host is the one outcome worse than no affordance.
 *
 * SHARED BY BOTH CREATE METHODS. `epic.createChat@1.2` gained the same
 * `refusal` key over the same `@1.2` kind enum, so the two now share a failure
 * mode and therefore its rendering; a second copy of this would let the same
 * refusal be spelled two ways on two surfaces. It lives in `lib/` rather than
 * beside either mutation for that reason.
 */
export function reportEpicCreateRefusal(
  refusal: EpicCreateRefusalV12,
  hostId: string | null,
): void {
  // The Repair affordance is keyed on the KIND, not on having a host.
  // `@1.2` widened this enum (`missing-attachment-bytes`), and the repair
  // dialog rebinds a LOCAL STORE - an action that would do nothing about bytes
  // the host could not find, while telling the user it might. Anything but
  // `local-store-unavailable` renders the host's own two sentences and stops
  // there, which is the honest rendering for a refusal whose remedy is the
  // client's to perform - and for `missing-attachment-bytes` the client has
  // already performed it once, from inside the create's own dispatch, before
  // this refusal was allowed to reach a user at all.
  if (hostId === null || refusal.kind !== "local-store-unavailable") {
    toast.error(refusal.message, { description: refusal.remedy });
    return;
  }
  // Re-stated rather than spread: narrowing `refusal.kind` above narrows the
  // PROPERTY, not the object, so the repair store's one-kind refusal type has
  // to be constructed. That is also the seam that keeps it one-kind - a future
  // kind cannot reach the dialog by accident.
  const localStoreRefusal: EpicCreateRefusal = {
    kind: "local-store-unavailable",
    message: refusal.message,
    remedy: refusal.remedy,
  };
  toast.error(refusal.message, {
    description: refusal.remedy,
    action: {
      label: "Repair",
      onClick: () => {
        openLocalStoreRepair({ hostId, refusal: localStoreRefusal });
      },
    },
  });
}
