import { useEffect, useRef, useState } from "react";
import type { LinkLoginDeepLinkDelivery } from "@traycer-clients/shared/platform/runner-host";
import type {
  LinkLoginFailureKind,
  LinkLoginSignInResult,
} from "@/lib/auth/auth-service";
import { decideDeepLinkRouting } from "@/lib/auth/link-login-deep-link-routing";
import { useAuthService } from "@/lib/host";
import { linkLoginAlreadySignedInToast } from "@/lib/toast/channels";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLinkLoginDeepLinkOutcomeStore } from "@/stores/auth/link-login-deep-link-outcome-store";

/**
 * The stored verdict for a settled claim, or `null` when this outcome is not
 * the code's verdict at all. Kept beside the bridge rather than inline so the
 * three-way distinction is stated once and read as a rule.
 */
function codeVerdictOf(
  result: LinkLoginSignInResult,
): LinkLoginFailureKind | null {
  if (
    result.kind === "signed-in" ||
    result.kind === "superseded" ||
    result.kind === "failed"
  ) {
    return null;
  }
  return result.kind;
}

/**
 * The single subscriber to `IRunnerHost.linkLoginDeepLinks` — a link code the
 * OS handed this app, from a QR scanned by the system camera.
 *
 * The shell buffers the launch URL and replays it on subscribe, so mounting
 * late (the host runtime boots behind a fallback surface) is normal rather
 * than a race to lose. One subscriber and no more: the replay is a hand-off,
 * so a second one would either steal the code or double-claim it.
 *
 * This bridge, and not the sign-in surface, owns the claim. Two of the three
 * states it decides between are states where that surface does not exist —
 * already signed in, and not yet mounted — so putting the decision there would
 * mean the cases that most need answering are the ones with nobody to answer
 * them. The claim goes through the same `AuthService.signInWithLinkCode` the
 * surface's own mutation calls, so everything downstream — the supersede
 * fence, the approval poll, the progress the wait UI renders — is identical
 * whichever way the code arrived.
 *
 * Nothing here dedupes by CODE. The shell already decided which arrivals are
 * intentional, and it is the only layer that can (see
 * `ILinkLoginDeepLinkSource`); a second value-keyed guard at this layer would
 * silently discard the deliberate rescan the shell just took care to pass on.
 */
export function LinkLoginDeepLinkBridge(): null {
  const auth = useAuthService();
  const runnerHost = useRunnerHostOrNull();
  const status = useAuthStore((state) => state.status);
  const reportOutcome = useLinkLoginDeepLinkOutcomeStore(
    (state) => state.report,
  );
  const clearOutcome = useLinkLoginDeepLinkOutcomeStore((state) => state.clear);
  const [delivery, setDelivery] = useState<LinkLoginDeepLinkDelivery | null>(
    null,
  );
  /**
   * The arrival this bridge has already acted on, by delivery identity. A ref,
   * not state: it records what was DONE rather than anything rendered, and
   * re-rendering on it would be the cascade it exists to prevent.
   */
  const actedOnDeliveryId = useRef<number | null>(null);
  const deepLinks = runnerHost === null ? null : runnerHost.linkLoginDeepLinks;

  useEffect(() => {
    if (deepLinks === null) {
      return;
    }
    const subscription = deepLinks.onLinkLoginCode((next) => {
      setDelivery(next);
    });
    return () => {
      subscription.dispose();
    };
  }, [deepLinks]);

  useEffect(() => {
    if (
      delivery === null ||
      actedOnDeliveryId.current === delivery.deliveryId
    ) {
      return;
    }
    const routing = decideDeepLinkRouting(status);
    if (routing === "hold") {
      // Deliberately nothing: a sign-in is mid-flight and the code stays
      // pending. This effect runs again when the status settles.
      return;
    }
    actedOnDeliveryId.current = delivery.deliveryId;
    if (routing === "already-signed-in") {
      linkLoginAlreadySignedInToast.info(
        "Already signed in on this phone — nothing to approve.",
      );
      return;
    }
    // A fresh claim retires the previous one's verdict, so a second scan does
    // not sit under the first one's complaint while it runs.
    clearOutcome();
    // The outcome is reported, not swallowed. A scanned code is most often
    // dead rather than wrong - the account holds one live code, so a re-mint
    // kills the QR still on the desktop screen - and "try again" is the one
    // thing that cannot work then. Published from the settled promise, so the
    // sign-in surface can render the real reason whether or not it was even
    // mounted when the claim started.
    //
    // Only CODE VERDICTS are stored, which is what `LinkLoginFailureKind`
    // narrows to. The other two non-success outcomes each already have their
    // presentation settled elsewhere: `superseded` says nothing at all (a
    // discarded attempt's complaint would land under whatever replaced it),
    // and `failed` — approved, then a broken finalization — is showing as the
    // global sign-in error, where it belongs.
    void auth.signInWithLinkCode(delivery.code).then((result) => {
      const verdict = codeVerdictOf(result);
      if (verdict !== null) {
        reportOutcome(verdict);
      }
    });
  }, [auth, clearOutcome, delivery, reportOutcome, status]);

  // The verdict belongs to ONE attempt. Any newer attempt starting, and the
  // identity transition when one succeeds, both retire it — otherwise a notice
  // from a camera scan outlives its own flow and reappears on a later sign-in
  // screen, describing something the user has since moved on from.
  useEffect(() => {
    if (status === "signed-out") {
      return;
    }
    clearOutcome();
  }, [clearOutcome, status]);

  return null;
}
