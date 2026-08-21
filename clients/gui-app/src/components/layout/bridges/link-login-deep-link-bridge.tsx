import { useEffect, useRef, useState } from "react";
import { decideDeepLinkRouting } from "@/lib/auth/link-login-deep-link-routing";
import { useAuthService } from "@/lib/host";
import { linkLoginAlreadySignedInToast } from "@/lib/toast/channels";
import { useRunnerHostOrNull } from "@/providers/use-runner-host";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useLinkLoginDeepLinkOutcomeStore } from "@/stores/auth/link-login-deep-link-outcome-store";

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
 */
export function LinkLoginDeepLinkBridge(): null {
  const auth = useAuthService();
  const runnerHost = useRunnerHostOrNull();
  const status = useAuthStore((state) => state.status);
  const reportOutcome = useLinkLoginDeepLinkOutcomeStore(
    (state) => state.report,
  );
  const clearOutcome = useLinkLoginDeepLinkOutcomeStore((state) => state.clear);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  /**
   * The last code this bridge has already acted on. A ref, not state: it
   * records what was DONE rather than anything rendered, and re-rendering on
   * it would be the cascade it exists to prevent.
   */
  const actedOnCode = useRef<string | null>(null);
  const deepLinks = runnerHost === null ? null : runnerHost.linkLoginDeepLinks;

  useEffect(() => {
    if (deepLinks === null) {
      return;
    }
    const subscription = deepLinks.onLinkLoginCode((code) => {
      setPendingCode(code);
    });
    return () => {
      subscription.dispose();
    };
  }, [deepLinks]);

  useEffect(() => {
    if (pendingCode === null || actedOnCode.current === pendingCode) {
      return;
    }
    const routing = decideDeepLinkRouting(status);
    if (routing === "hold") {
      // Deliberately nothing: a sign-in is mid-flight and the code stays
      // pending. This effect runs again when the status settles.
      return;
    }
    actedOnCode.current = pendingCode;
    if (routing === "already-signed-in") {
      linkLoginAlreadySignedInToast.info(
        "Already signed in on this phone — nothing to approve.",
      );
      return;
    }
    // The outcome is reported, not swallowed. A scanned code is most often
    // dead rather than wrong - the account holds one live code, so a re-mint
    // kills the QR still on the desktop screen - and "try again" is the one
    // thing that cannot work then. Published from the settled promise, so the
    // sign-in surface can render the real reason whether or not it was even
    // mounted when the claim started.
    // A fresh claim retires the previous one's verdict, so a second scan does
    // not sit under the first one's complaint while it runs.
    clearOutcome();
    void auth.signInWithLinkCode(pendingCode).then((result) => {
      if (result.kind !== "signed-in") {
        reportOutcome(result.kind);
      }
    });
  }, [auth, clearOutcome, pendingCode, reportOutcome, status]);

  return null;
}
