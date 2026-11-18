import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger } from "@/lib/logger";
import { useAuthService } from "@/lib/host";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  createRetainingReportAction,
  reportableWarningToast,
} from "@/lib/reportable-error-toast";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { authSessionRefusedToast } from "@/lib/toast/channels";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";
import type {
  DesktopAuthSessionPendingReason,
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
 *   - Main's answer is shown as one notice. `pending` (main could not check
 *     the token yet and keeps checking it) is about main's check: it stays
 *     until main fans out any session (its verified echo of this one, or
 *     another), or until a verdict against this bearer replaces it with the
 *     refused notice. `refused` is about this window's own bearer: it names
 *     its reason and, for a verdict against the token, offers Sign out, and
 *     it stays until this window's own session changes - its next write, or
 *     main's session actually landing in its AuthService. Every notice shows
 *     the reason code and offers Report issue.
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

    // Main's sessions this window is projecting, counted per projection still
    // in flight: a fan-out can arrive while an earlier one is still being
    // validated, and the earlier one settling must not end the later one.
    const projecting = new Map<string, number>();
    let lastWrittenSerialized: string | null = null;
    // The bearer of `lastWrittenSerialized`; read only while that is set.
    let lastWrittenToken: string | null = null;
    // A write main has since moved past: main fanned out a session after it
    // (its verified echo, or another), so a `pending` answer for it still in
    // flight then describes a check main is no longer making.
    let movedPastSerialized: string | null = null;
    // What the notice on screen is about: main's undecided check (`pending`),
    // or this window's own bearer (`refused`).
    let noticeKind: "pending" | "refused" | null = null;
    let lastLocalRestoreSerialized: string | null = null;

    const dismissNotice = (): void => {
      noticeKind = null;
      authSessionRefusedToast.dismiss();
    };

    const showNotice = (
      notice: AuthSessionNotice,
      kind: "pending" | "refused",
      onSignOut: (() => void) | null,
    ): void => {
      noticeKind = kind;
      showAuthSessionNotice(notice, onSignOut);
    };

    // Shown in the notice's place, on its toast id. Sonner merges a toast's
    // options into the toast already up under that id, so every option the
    // notice sets is cleared here; otherwise the notice's description, code
    // and Report issue (with the notice's context) stay under this title.
    const showLocalRestoreWarning = (message: string): void => {
      noticeKind = null;
      toast.warning(message, {
        id: authSessionRefusedToast.id,
        duration: undefined,
        description: undefined,
        action: undefined,
        cancel: null,
      });
    };

    const signOutFromNotice = (): void => {
      Analytics.getInstance().track(AnalyticsEvent.SignOutRequested, {
        source: "notification",
      });
      void auth.signOut();
    };

    const restoreLocal = (snapshot: AuthSessionSnapshot): void => {
      if (
        bridge.authSession.restoreLocal === undefined ||
        snapshot.token === null ||
        snapshot.profile === null
      ) {
        return;
      }
      const expected = {
        userId: snapshot.profile.userId,
        token: snapshot.token,
      };
      const serialized = JSON.stringify(expected);
      if (lastLocalRestoreSerialized === serialized) return;
      lastLocalRestoreSerialized = serialized;
      void bridge.authSession.restoreLocal(expected).then(
        (result) => {
          if (result === "restored") return;
          if (lastLocalRestoreSerialized === serialized) {
            lastLocalRestoreSerialized = null;
          }
          if (result === "unavailable") {
            showLocalRestoreWarning(
              "Traycer could not read your local session. Reload the window to try again.",
            );
          }
        },
        () => {
          if (lastLocalRestoreSerialized === serialized) {
            lastLocalRestoreSerialized = null;
          }
          appLogger.warn(
            "[auth] could not restore the desktop local session",
            {},
          );
          showLocalRestoreWarning(
            "Traycer could not restore your local session. Reload the window to try again.",
          );
        },
      );
    };

    const writeOutbound = (snapshot: AuthSessionSnapshot): void => {
      if (projecting.size > 0) {
        // This window's own session changed while it projected main's, so a
        // notice about the session it held no longer applies. When the change
        // is one of main's sessions landing, the latch moves to it and its
        // echo is not written back.
        dismissNotice();
        if (snapshot.status === "unverified") return;
        const adopted = toDesktopSnapshot(snapshot);
        const serialized = serializeDesktopSnapshot(adopted);
        if (projecting.has(serialized)) {
          lastWrittenSerialized = serialized;
          lastWrittenToken = adopted.token;
        }
        return;
      }
      if (snapshot.status === "unverified") {
        // Main needs a local identity to select the already-running host.
        // It reads that identity from disk rather than trusting this profile;
        // siblings still derive their own offline session independently.
        // Clear the verified echo latch so a same-token promotion is published.
        lastWrittenSerialized = null;
        restoreLocal(snapshot);
        return;
      }
      lastLocalRestoreSerialized = null;
      const desktopSnapshot = toDesktopSnapshot(snapshot);
      const serialized = serializeDesktopSnapshot(desktopSnapshot);
      if (serialized === lastWrittenSerialized) {
        return;
      }
      lastWrittenSerialized = serialized;
      lastWrittenToken = desktopSnapshot.token;
      movedPastSerialized = null;
      // A newer session makes any notice about an older one stale.
      dismissNotice();
      void bridge.authSession.set(desktopSnapshot).then(
        (result) => {
          if (result.outcome === "pending") {
            // Main holds this exact session and keeps checking it, so the latch
            // stays: its fan-out once verified is this window's own echo.
            if (lastWrittenSerialized !== serialized) return;
            if (movedPastSerialized === serialized) return;
            showNotice(
              pendingNotice(result.reason, result.heldLocally),
              "pending",
              null,
            );
            return;
          }
          if (result.outcome !== "refused") return;
          // The latch is an echo suppressor, not a record of what the bridge
          // holds: a refused write left nothing there, so keeping it latched
          // makes the very next projection of the SAME snapshot a no-op and
          // the window never re-attempts. Cleared only while the latch is
          // still this write's - a newer projection has already superseded it.
          // A refusal of an older write says nothing about the session now.
          if (lastWrittenSerialized !== serialized) return;
          lastWrittenSerialized = null;
          const notice = refusalNotice(result.reason);
          showNotice(
            notice,
            "refused",
            notice.offersSignOut ? signOutFromNotice : null,
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

    const ingestInbound = (snapshot: DesktopAuthSessionSnapshot): void => {
      // Main's local selection identity is neither a cloud verdict nor a
      // sign-out. Each window restores it through its own AuthService.
      if (snapshot.status === "unverified") return;
      // Whichever session main fanned out, it has moved past the check a
      // pending notice describes, and past a `pending` answer still in flight.
      // A refused notice is about this window's own bearer: it stays until
      // this window's session changes (`writeOutbound`).
      if (noticeKind === "pending") dismissNotice();
      movedPastSerialized = lastWrittenSerialized;
      const serialized = serializeDesktopSnapshot(snapshot);
      if (serialized === lastWrittenSerialized) return;
      // Not adopted until this window's AuthService says so: it re-validates
      // the bearer and keeps its own session when that fails. The latch moves
      // only when the session lands (`writeOutbound`).
      projecting.set(serialized, (projecting.get(serialized) ?? 0) + 1);
      const projection = fromDesktopSnapshot(snapshot);
      void auth.ingestProjectedSessionSnapshot(projection).finally(() => {
        const inFlight = projecting.get(serialized) ?? 1;
        if (inFlight > 1) projecting.set(serialized, inFlight - 1);
        else projecting.delete(serialized);
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

    // Main's own re-check of a session it answered `pending` for reached a
    // verdict. The set's answer came long ago, so this is the refused answer
    // arriving late, and it is applied exactly as one: the latch clears and the
    // verdict notice replaces the pending one. Fenced to the bearer this window
    // wrote; any other bearer is not this window's verdict.
    const pendingRefusedSubscription =
      bridge.authSession.onPendingRefused?.((token, reason) => {
        if (lastWrittenSerialized === null || lastWrittenToken !== token) {
          return;
        }
        lastWrittenSerialized = null;
        const notice = refusalNotice(reason);
        showNotice(
          notice,
          "refused",
          notice.offersSignOut ? signOutFromNotice : null,
        );
      }) ?? null;

    // HostRuntimeProvider has already awaited auth.start(), restoring the
    // shared credentials file. Subscribing synchronously replays that session
    // to main. Do not read main's initial projection back: its signed-in write
    // awaits bearer verification, so a concurrent get can still return the
    // default signed-out snapshot and undo the restore until verification ends.
    // Listen first so subsequent cross-window transitions remain observable.
    const sessionSubscription = auth.onSessionSnapshotChange(writeOutbound);

    return () => {
      sessionSubscription.dispose();
      inboundSubscription.dispose();
      revokeSubscription.dispose();
      verdictLossSubscription?.dispose();
      pendingRefusedSubscription?.dispose();
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

/**
 * One sign-in notice. `code` is the reason main gave, shown as-is so the
 * person can quote it and carried into the report; it is a statement about
 * the token, never about the account, and the notice carries nothing else
 * that identifies anyone.
 */
interface AuthSessionNotice {
  readonly title: string;
  readonly description: string;
  readonly code: DesktopAuthSessionRefusalReason;
  readonly offersSignOut: boolean;
}

const CANNOT_REACH_SIGN_IN = "Can't reach Traycer's sign-in service.";
const STILL_CONFIRMING_SIGN_IN = "Traycer is still confirming your sign-in.";
const OTHER_DEVICES_AFTER_REACHING =
  "Hosts on your other devices will appear once it's back.";
const OTHER_DEVICES_AFTER_CONFIRMING =
  "Hosts on your other devices will appear once it's done.";
const KEEPS_TRYING = "Traycer will keep trying.";

/** Main keeps checking the session; nothing for the person to do but wait. */
function pendingNotice(
  reason: DesktopAuthSessionPendingReason,
  heldLocally: boolean,
): AuthSessionNotice {
  if (reason === "key-source-unavailable") {
    return {
      title: CANNOT_REACH_SIGN_IN,
      description: heldLocally ? OTHER_DEVICES_AFTER_REACHING : KEEPS_TRYING,
      code: reason,
      offersSignOut: false,
    };
  }
  return {
    title: STILL_CONFIRMING_SIGN_IN,
    description: heldLocally ? OTHER_DEVICES_AFTER_CONFIRMING : KEEPS_TRYING,
    code: reason,
    offersSignOut: false,
  };
}

/**
 * A verdict against the token: a fresh sign-in mints one main can check, so
 * signing out and back in is the action. The two reasons a shell from before
 * `pending` still refuses with are not verdicts, and signing out would not
 * help with them.
 */
function refusalNotice(
  reason: DesktopAuthSessionRefusalReason,
): AuthSessionNotice {
  if (
    reason === "key-source-unavailable" ||
    reason === "signing-key-unconfirmed"
  ) {
    return {
      title: CANNOT_REACH_SIGN_IN,
      description: "Restart Traycer once you're back online.",
      code: reason,
      offersSignOut: false,
    };
  }
  return {
    title: "Traycer couldn't confirm this sign-in.",
    description: "Sign out and back in.",
    code: reason,
    offersSignOut: true,
  };
}

/**
 * Stays up until the session changes or the person closes it: while main is
 * still checking, the startup card can be what is behind it. Report issue
 * keeps the notice on screen so its code stays readable; Sign out ends it.
 */
function showAuthSessionNotice(
  notice: AuthSessionNotice,
  onSignOut: (() => void) | null,
): void {
  const report = createReportIssueContext({
    title: notice.title,
    message: notice.description,
    code: notice.code,
    source: "Desktop sign-in",
  });
  reportableWarningToast(
    notice.title,
    {
      id: authSessionRefusedToast.id,
      duration: Number.POSITIVE_INFINITY,
      description: (
        <span className="flex flex-col gap-1">
          <span>{notice.description}</span>
          <span className="font-mono text-code-xs text-muted-foreground select-text">
            {notice.code}
          </span>
        </span>
      ),
      action: createRetainingReportAction(report),
      cancel:
        onSignOut === null ? null : { label: "Sign out", onClick: onSignOut },
    },
    report,
  );
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
