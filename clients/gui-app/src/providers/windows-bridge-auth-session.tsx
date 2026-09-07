import { useEffect, type ReactNode } from "react";
import { appLogger } from "@/lib/logger";
import { useAuthService } from "@/lib/host";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import { authSessionRefusedToast } from "@/lib/toast/channels";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";
import type {
  DesktopAuthSessionRefusalReason,
  DesktopAuthSessionSnapshot,
} from "@/lib/windows/types";

/** Cross-window bearer projection. Must live below `HostRuntimeProvider` and talk to `AuthService` directly, not `useAuthStore`. Inbound snapshots are re-validated through AuthnV3 before minting a fresh `RequestContext`. */
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

    const writeOutbound = (snapshot: AuthSessionSnapshot): void => {
      if (projectingInbound) return;
      const desktopSnapshot = toDesktopSnapshot(snapshot);
      const serialized = serializeDesktopSnapshot(desktopSnapshot);
      if (serialized === lastWrittenSerialized) {
        return;
      }
      lastWrittenSerialized = serialized;
      void bridge.authSession.set(desktopSnapshot).then(
        (result) => {
          if (result.outcome !== "refused") return;
          // Clear the echo latch on refusal so the next same snapshot is
          // retried. Skip if a newer projection already superseded it.
          if (lastWrittenSerialized === serialized)
            lastWrittenSerialized = null;
          authSessionRefusedToast.warning(
            describeAuthSessionRefusalReason(result.reason),
          );
        },
        (cause: unknown) => {
          // IPC reject leaves the same stuck latch. Clear it so the next same
          // snapshot is retried.
          if (lastWrittenSerialized === serialized)
            lastWrittenSerialized = null;
          appLogger.warn("[auth] could not write the desktop auth session", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
    };

    const ingestInbound = (snapshot: DesktopAuthSessionSnapshot): void => {
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
    // Subscribe to replay the restored session. Do not read main's get() back:
    // it can still be signed-out while bearer verification is pending.
    const sessionSubscription = auth.onSessionSnapshotChange(writeOutbound);

    return () => {
      sessionSubscription.dispose();
      inboundSubscription.dispose();
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
