import { useEffect, type ReactNode } from "react";
import { appLogger } from "@/lib/logger";
import { useAuthService } from "@/lib/host";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { authSessionRefusedToast } from "@/lib/toast/channels";
import { onWakeReconnect } from "@/lib/host/wake-reconnect";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";
import type {
  DesktopAuthSessionRefusalReason,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";

/**
 * Cross-window auth-projection bridge for the desktop windows bridge.
 *
 * This is the explicit persistence-boundary path for raw bearer material
 * between sibling windows. It MUST live below `HostRuntimeProvider` so it
 * can talk to `AuthService` directly through the boundary surface
 * (`getCurrentSessionSnapshot` / `onSessionSnapshotChange` /
 * `ingestProjectedSessionSnapshot`) instead of routing the bearer through
 * the public `useAuthStore` runtime state.
 *
 * Behavior:
 *
 *   - Outbound (this window → bridge): subscribes to
 *     `auth.onSessionSnapshotChange` and projects each snapshot into
 *     `bridge.authSession.set(...)`. Same-user refresh and signed-out
 *     transitions are forwarded so sibling windows stay in sync.
 *   - Inbound (bridge → this window): subscribes to
 *     `bridge.authSession.onChange` and forwards each inbound snapshot to
 *     `auth.ingestProjectedSessionSnapshot(...)`. The auth service
 *     re-validates the bearer through AuthnV3 before minting a fresh
 *     `RequestContext`, then writes only `status / profile / contextMetadata`
 *     into the public store.
 *
 * The component renders its `children` so it can sit transparently inside
 * the host-runtime children tree.
 */
/**
 * How often, while main holds this window's session as the local computer
 * only, the window hands it over again. Main fetches its signing keys at most
 * once a minute, so a shorter interval only meets its cooldown.
 */
const LOCAL_HOLD_RESEND_MS = 60_000;

export interface WindowsBridgeAuthSessionBridgeProps {
  readonly children: ReactNode;
}

export function WindowsBridgeAuthSessionBridge(
  props: WindowsBridgeAuthSessionBridgeProps,
): ReactNode {
  const bridge = useWindowsBridge();
  const auth = useAuthService();

  useEffect(() => {
    if (bridge === null) {
      return;
    }

    let projectingInbound = false;
    let lastWrittenSerialized: string | null = null;
    let lastLocalRestoreSerialized: string | null = null;
    // The session main refused for want of its signing keys (no network) and
    // now holds as the local computer only, and the one whose local restore
    // is in flight. One restore per held session.
    let heldLocally: string | null = null;
    let restoringLocally: string | null = null;
    let localHoldResendTimer: number | null = null;
    // The held session main has since judged bad: told once and, for the
    // verdicts authn can settle, asked about once - not once per tick.
    let judgedHeld: string | null = null;

    const releaseLocalHold = (): void => {
      heldLocally = null;
      restoringLocally = null;
      judgedHeld = null;
      if (localHoldResendTimer !== null) {
        window.clearInterval(localHoldResendTimer);
        localHoldResendTimer = null;
      }
    };

    const restoreLocal = (
      snapshot: AuthSessionSnapshot,
      onSettled: ((restored: boolean) => void) | null,
    ): void => {
      if (
        bridge.authSession.restoreLocal === undefined ||
        snapshot.token === null ||
        snapshot.profile === null
      ) {
        onSettled?.(false);
        return;
      }
      const expected = {
        userId: snapshot.profile.userId,
        token: snapshot.token,
      };
      const serialized = JSON.stringify(expected);
      // A caller that waits on the answer (the fallback) keys itself, and a
      // skipped restore would never answer it.
      if (onSettled === null && lastLocalRestoreSerialized === serialized)
        return;
      lastLocalRestoreSerialized = serialized;
      void bridge.authSession.restoreLocal(expected).then(
        (result) => {
          onSettled?.(result === "restored");
          if (result === "restored") return;
          if (lastLocalRestoreSerialized === serialized) {
            lastLocalRestoreSerialized = null;
          }
          if (result === "unavailable") {
            authSessionRefusedToast.warning(
              "Traycer could not read your local session. Reload the window to try again.",
            );
          }
        },
        () => {
          onSettled?.(false);
          if (lastLocalRestoreSerialized === serialized) {
            lastLocalRestoreSerialized = null;
          }
          appLogger.warn(
            "[auth] could not restore the desktop local session",
            {},
          );
          authSessionRefusedToast.warning(
            "Traycer could not restore your local session. Reload the window to try again.",
          );
        },
      );
    };

    const writeOutbound = (snapshot: AuthSessionSnapshot): void => {
      if (projectingInbound) return;
      if (snapshot.status === "unverified") {
        // Main needs a local identity to select the already-running host.
        // It reads that identity from disk rather than trusting this profile;
        // siblings still derive their own offline session independently.
        // Clear the verified echo latch so a same-token promotion is published.
        lastWrittenSerialized = null;
        restoreLocal(snapshot, null);
        return;
      }
      // A sign-out (or a sign-in starting) is not a session to hold.
      if (snapshot.status !== "signed-in") releaseLocalHold();
      lastLocalRestoreSerialized = null;
      const desktopSnapshot = toDesktopSnapshot(snapshot);
      const serialized = serializeDesktopSnapshot(desktopSnapshot);
      if (serialized === lastWrittenSerialized) {
        return;
      }
      // A different session (a rotated token, another sign-in) is not the one
      // held: it is handed over afresh and takes its own fallback if it must.
      if (heldLocally !== null && heldLocally !== serialized)
        releaseLocalHold();
      lastWrittenSerialized = serialized;
      void bridge.authSession.set(desktopSnapshot).then(
        (result) => {
          if (result.outcome !== "refused") {
            releaseLocalHold();
            return;
          }
          // The latch is an echo suppressor, not a record of what the bridge
          // holds: a refused write left nothing there, so keeping it latched
          // makes the very next projection of the SAME snapshot a no-op and
          // the window never re-attempts. Cleared only while the latch is
          // still this write's - a newer projection has already superseded it.
          const current = lastWrittenSerialized === serialized;
          if (current) lastWrittenSerialized = null;
          // Main could not reach its signing keys (no network), so it lists
          // no computer at all. The local computer needs no cloud verdict:
          // restore it as an unverified session would, and hand this session
          // over again until main verifies it. No toast: the app works, and a
          // failed restore says so itself. Every other refusal is a statement
          // about the token and adopts nothing.
          if (result.reason === "key-source-unavailable") {
            // A superseded write's answer decides nothing: the current
            // write's own answer takes the fallback, silently.
            if (!current) return;
            if (heldLocally === serialized || restoringLocally === serialized)
              return;
            restoringLocally = serialized;
            restoreLocal(snapshot, (restored) => {
              if (restoringLocally !== serialized) return;
              restoringLocally = null;
              if (!restored) return;
              heldLocally = serialized;
              localHoldResendTimer ??= window.setInterval(
                resendWhileHeldLocally,
                LOCAL_HOLD_RESEND_MS,
              );
            });
            return;
          }
          if (heldLocally !== null && current) {
            // A held session main now judges bad (its keys came back): told
            // once per judged session, never on every tick. For a verdict
            // authn can settle, ask it at once, as the start's own validation
            // would: a refresh is handed over, a rejection signs out, an
            // acceptance is handed over on the next tick, and an unreachable
            // authn leaves the hold as it is.
            if (judgedHeld === serialized) return;
            judgedHeld = serialized;
            if (
              result.reason === "bad-signature" ||
              result.reason === "unknown-signing-key" ||
              result.reason === "expired"
            ) {
              void auth.revalidateCurrentContext().catch((cause: unknown) => {
                appLogger.warn("[auth] could not revalidate a held session", {
                  cause: cause instanceof Error ? cause.message : String(cause),
                });
              });
            }
          }
          authSessionRefusedToast.warning(
            describeAuthSessionRefusalReason(result.reason),
          );
        },
        (cause: unknown) => {
          // An IPC invoke that REJECTS - the main handler threw, the channel is
          // absent, the window is being destroyed - leaves exactly the stuck
          // latch the refusal branch above exists to prevent, plus an unhandled
          // rejection. Same clearing rule, so the next projection of the same
          // snapshot is attempted again.
          if (lastWrittenSerialized === serialized)
            lastWrittenSerialized = null;
          appLogger.warn("[auth] could not write the desktop auth session", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
    };

    // The way back from a local hold: hand the same session over again so main
    // can verify it. A hand-over still in flight holds the latch, so an
    // attempt never overlaps another.
    const resendWhileHeldLocally = (): void => {
      if (heldLocally === null) return;
      writeOutbound(auth.getCurrentSessionSnapshot());
    };

    const ingestInbound = (snapshot: DesktopAuthSessionSnapshot): void => {
      // Main's local selection identity is neither a cloud verdict nor a
      // sign-out. Each window restores it through its own AuthService.
      if (snapshot.status === "unverified") return;
      // A signed-in session from main is one it verified: no local hold left.
      if (snapshot.status === "signed-in") releaseLocalHold();
      const serialized = serializeDesktopSnapshot(snapshot);
      if (serialized === lastWrittenSerialized) {
        return;
      }
      lastWrittenSerialized = serialized;
      projectingInbound = true;
      const projection = fromDesktopSnapshot(snapshot);
      void auth.ingestProjectedSessionSnapshot(projection).finally(() => {
        projectingInbound = false;
      });
    };

    const inboundSubscription = bridge.authSession.onChange(ingestInbound);
    // A TERMINAL verdict loss also needs an explicit revocation.
    // Local restoration above grants no cloud verdict and does not demote
    // an existing main session, so terminal revocation travels on its own
    // channel. Main drops its verification of the session it holds - what the
    // jar plane's principal reads - and fans the session back out UNCHANGED,
    // which every window's latch reads as an echo. The latch here stays put
    // for the same reason: a later sign-in carries a new bearer, so it is a
    // new serialization and is written. A desktop shell built before the
    // channel existed has no `revoke`; it keeps the pre-channel behaviour.
    const revokeSubscription = auth.onCloudAuthorizationRevoked((revoked) => {
      const pending = bridge.authSession.revoke?.(
        revoked.token,
        revoked.revocation,
      );
      if (pending === undefined) return;
      void pending.catch((cause: unknown) => {
        appLogger.warn("[auth] could not revoke the desktop auth session", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });

    // The INBOUND half of the same edge: another window lost its verdict and
    // main has fanned that out here. Without this the demotion was strictly
    // window-local - main's own verification went, but this renderer's store
    // stayed `signed-in` and kept dispatching cloud work on the refused
    // bearer until it happened to revalidate on its own. `onChange` cannot
    // carry it: main republishes the SAME snapshot, which `ingestInbound`
    // above discards as an echo by design.
    //
    // The service fences on the bearer and no-ops when this window holds a
    // different (or already-unverified) session, so an unordered revoke that
    // lands after a fresh sign-in here leaves that session alone. A desktop
    // shell built before the channel existed has no `onVerificationRevoked`;
    // it keeps the pre-channel behaviour.
    const verdictLossSubscription =
      bridge.authSession.onVerificationRevoked?.(
        (rejectedToken, revocation) => {
          auth.ingestCloudAuthorizationRevoked(rejectedToken, revocation);
        },
      ) ?? null;

    // HostRuntimeProvider has already awaited auth.start(), restoring the
    // shared credentials file. Subscribing synchronously replays that session
    // to main. Do not read main's initial projection back: its signed-in write
    // awaits bearer verification, so a concurrent get can still return the
    // default signed-out snapshot and undo the restore until verification ends.
    // Listen first so subsequent cross-window transitions remain observable.
    const sessionSubscription = auth.onSessionSnapshotChange(writeOutbound);

    const disposeWake = onWakeReconnect(resendWhileHeldLocally);

    return () => {
      disposeWake();
      releaseLocalHold();
      sessionSubscription.dispose();
      inboundSubscription.dispose();
      revokeSubscription.dispose();
      verdictLossSubscription?.dispose();
    };
  }, [auth, bridge]);

  return <>{props.children}</>;
}

function toDesktopSnapshot(
  snapshot: AuthSessionSnapshot,
): DesktopAuthSessionSnapshot {
  if (
    snapshot.status === "signed-in" &&
    snapshot.token !== null &&
    snapshot.profile !== null
  ) {
    return {
      status: "signed-in",
      token: snapshot.token,
      profile: snapshot.profile,
    };
  }
  if (snapshot.status === "signing-in") {
    return {
      status: "signing-in",
      token: null,
      profile: null,
    };
  }
  return {
    status: "signed-out",
    token: null,
    profile: null,
  };
}

function fromDesktopSnapshot(
  snapshot: DesktopAuthSessionSnapshot,
): AuthSessionSnapshot {
  if (snapshot.status === "signed-in") {
    return {
      status: "signed-in",
      token: snapshot.token,
      profile: snapshot.profile,
      contextMetadata: null,
    };
  }
  if (snapshot.status === "signing-in") {
    return {
      status: "signing-in",
      token: null,
      profile: null,
      contextMetadata: null,
    };
  }
  return {
    status: "signed-out",
    token: null,
    profile: null,
    contextMetadata: null,
  };
}

const AUTH_SESSION_REFUSAL_COPY: Record<
  DesktopAuthSessionRefusalReason,
  string
> = {
  "malformed-token": "the sign-in token was malformed",
  "unsupported-algorithm": "the sign-in token used an unsupported algorithm",
  "unknown-signing-key": "the sign-in token's signing key was not recognized",
  "key-source-unavailable": "the signing-key source was unavailable",
  "bad-signature": "the sign-in token's signature did not verify",
  expired: "the sign-in token had expired",
  "issuer-mismatch": "the sign-in token's issuer did not match",
  "audience-mismatch": "the sign-in token's audience did not match",
  "subject-mismatch": "the sign-in token's subject did not match",
};

/** Names the refusal category in plain words. Never renders the token. */
function describeAuthSessionRefusalReason(
  reason: DesktopAuthSessionRefusalReason,
): string {
  return `Traycer could not verify this sign-in with the auth service (${AUTH_SESSION_REFUSAL_COPY[reason]}). Sign out and back in.`;
}

function serializeDesktopSnapshot(
  snapshot: DesktopAuthSessionSnapshot,
): string {
  return JSON.stringify({
    status: snapshot.status,
    token: snapshot.token,
    profileUserId: snapshot.profile?.userId ?? null,
  });
}
