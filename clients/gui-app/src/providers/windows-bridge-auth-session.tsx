import { useEffect, type ReactNode } from "react";
import { useAuthService } from "@/lib/host";
import { useWindowsBridge } from "@/providers/windows-bridge-context";
import type { AuthSessionSnapshot } from "@/lib/auth/auth-service";
import type { DesktopAuthSessionSnapshot } from "@/lib/windows/types";

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
      void bridge.authSession.set(desktopSnapshot);
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

    const sessionSubscription = auth.onSessionSnapshotChange(writeOutbound);
    const inboundSubscription = bridge.authSession.onChange(ingestInbound);

    // Capture the identity generation BEFORE the delayed get so a stale
    // initial snapshot cannot overwrite a newer local mutation (or reconcile)
    // that landed while the get was in flight. ingestProjectedSessionSnapshot
    // fences its own validation await; this fences the pre-ingest await.
    void (async () => {
      const generationAtRead = auth.getIdentityGeneration();
      const initial = await bridge.authSession.get();
      if (auth.getIdentityGeneration() !== generationAtRead) {
        return;
      }
      ingestInbound(initial);
    })();

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

function serializeDesktopSnapshot(
  snapshot: DesktopAuthSessionSnapshot,
): string {
  return JSON.stringify({
    status: snapshot.status,
    token: snapshot.token,
    profileUserId: snapshot.profile?.userId ?? null,
  });
}
