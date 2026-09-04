import type {
  RevalidateOutcome,
  StreamAuthRevalidator,
} from "@traycer-clients/shared/auth/bearer-revalidator";
import type { AuthService } from "@/lib/auth/auth-service";
import { appLogger } from "@/lib/logger";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";

/**
 * Maps `AuthService.revalidateCurrentContext()` onto the transport-facing
 * `StreamAuthRevalidator` contract - the single normalization every
 * UNAUTHORIZED-recovering host transport uses (the local `/stream` client and
 * the remote session's session-fatal recovery). Non-hook so non-React owners
 * (the runtime host messenger, session stores) can build one; the
 * `useStreamAuthRevalidator` hook wraps this for render-path consumers.
 *
 * Lives beside `AuthService` (not under `lib/host/`) so the runtime provider
 * can import it without re-entering the `@/lib/host` barrel it itself feeds.
 */
export function createStreamAuthRevalidator(
  authService: AuthService,
): StreamAuthRevalidator {
  return {
    revalidateForReconnect: async (): Promise<RevalidateOutcome> => {
      const outcome = await authService.revalidateCurrentContext();
      if (outcome === null) {
        // No live signed-in context to revalidate (signed out / provider
        // torn down). Re-dialing without a credential is futile, and the
        // provider rebuilds dependent clients on sign-out anyway.
        appLogger.warn("[stream-auth] reconnect revalidation rejected", {
          reason: "no-context",
        });
        return "rejected";
      }
      if (outcome.kind === "valid") {
        // AuthnV3 accepts the credential (it may have rotated the bearer in
        // place). Re-dial; the open frame reads the live, possibly-fresh
        // bearer.
        appLogger.debug("[stream-auth] reconnect revalidation accepted", {
          outcome: "valid",
        });
        return "rotated";
      }
      if (outcome.kind === "network-error") {
        appLogger.warn(
          "[stream-auth] reconnect revalidation network error",
          {},
        );
        return "network-error";
      }
      // outcome.kind === "rejected". This used to be read as "revalidate has
      // already signed out", which was true of every terminal verdict until
      // `unverified` arrived. It no longer is: a terminal verdict on a held
      // identity DEMOTES rather than clears, keeping the session and its
      // local-plane admission (`demoteVerifiedSessionToUnverified`), and that
      // demotion is deliberately silent on the context so nothing else here
      // can observe it. Reporting it as terminal closed the local host's own
      // stream on the one state that exists to keep it open.
      //
      // Read the projected status rather than the outcome kind, because the
      // two arms are indistinguishable in the value: `rejected` is the
      // CREDENTIAL's verdict, and what happened to the SESSION is a separate
      // fact that the kind deliberately does not carry. The store is committed
      // before `revalidateCurrentContext` resolves, so this read is settled by
      // the time it runs.
      //
      // `admitsLocalPlane` rather than an inlined `=== "unverified"`, and the
      // wider predicate is the correct one rather than a convenient one: the
      // question this branch asks is "did the revalidator leave a session with
      // a local plane", and demotion is only its commonest yes. A store-
      // unavailable rotate also reports `rejected` while leaving the session
      // `signed-in` outright, and closing a local stream on that is the same
      // mistake for a different reason. Classifying the state once, here, is
      // also what `auth-store` asks of every new `AuthStatus` member.
      if (admitsLocalPlane(useAuthStore.getState().status)) {
        appLogger.warn("[stream-auth] reconnect revalidation demoted", {
          reason: "cloud-verdict-withdrawn",
        });
        return "local-plane-retained";
      }
      appLogger.warn("[stream-auth] reconnect revalidation rejected", {
        reason: "auth-rejected",
      });
      return "rejected";
    },
  };
}
