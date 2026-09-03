import { useCallback, type ReactNode } from "react";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import { landingTerminalsKey } from "@/lib/persist";
import { useHostClient, useHostDirectory } from "@/lib/host";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";
import {
  landingBrowserPendingKills,
  landingTerminalPendingKills,
  useLandingPanelStore,
} from "@/stores/home/landing-panel-store";
import { closeLandingBrowserTombstonesForSignOut } from "@/providers/landing-browser-tombstone-drain";

export interface LandingTerminalPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Retargets landing-terminal references with auth identity. Independent PTYs
 * are owned by one user, so a global/local anonymous bucket would otherwise
 * let a later sign-in adopt another user's sessions.
 */
export function LandingTerminalPersistLifecycleBridge(
  props: LandingTerminalPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);
  // Only to name the pre-userId key for one-time adoption; NOT an identity.
  const legacyEmail = useAuthStore((state) => state.profile?.email ?? null);
  const defaultClient = useHostClient();
  const directory = useHostDirectory();
  const drainTombstones = useCallback(() => {
    const pendingKills = useLandingPanelStore.getState().pendingKills;
    // Narrowed at the predicate, like every other consumer of this mixed list.
    // A browser tombstone's `sessionId` names the device's shared BROWSER
    // session, drawn from a namespace `landingTabRefKey` refuses to assume is
    // disjoint from terminal ids - which is why it carries a `kind` segment at
    // all. Sending it to `terminal.kill` is the wrong RPC for the record, and
    // on a collision it kills a live PTY nobody asked to kill.
    for (const pending of landingTerminalPendingKills(pendingKills)) {
      const entry = directory.findById(pending.hostId);
      const client =
        entry === null ? null : buildDialableHostClient(defaultClient, entry);
      if (client === null) continue;
      // Sign-out is a teardown boundary, not a UI request surface: retain no
      // promise and clear the identity bucket immediately afterwards. An
      // unreachable host keeps the documented residual exception.
      void client
        .request("terminal.kill", { sessionId: pending.sessionId })
        .then(
          () => undefined,
          () => undefined,
        );
    }
    // The browser half travels the coordinator, not an RPC of its own, so it
    // can only be discharged for a device whose stream is up in this window.
    closeLandingBrowserTombstonesForSignOut(
      landingBrowserPendingKills(pendingKills),
    );
  }, [defaultClient, directory]);
  const onTransition = useCallback(
    (transition: AuthIdentityTransition) => {
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useLandingPanelStore,
          name: landingTerminalsKey(transition.userId),
          // Never the anonymous bucket: a null email must not adopt shared state into an account.
          legacyName:
            legacyEmail === null ? null : landingTerminalsKey(legacyEmail),
        });
        return;
      }
      drainTombstones();
      clearAndResetPersistedStore({
        store: useLandingPanelStore,
        anonymousName: landingTerminalsKey(null),
      });
    },
    [drainTombstones, legacyEmail],
  );

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
