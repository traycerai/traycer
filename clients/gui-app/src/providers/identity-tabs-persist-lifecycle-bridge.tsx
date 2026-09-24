import { useCallback, type ReactNode } from "react";
import { useIdentityTabsStore } from "@/stores/identities/identity-tabs-store";
import { identityTabsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  clearAndResetPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface IdentityTabsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Retargets the persisted Identities-tab bucket whenever the signed-in
 * account changes, the way `EpicCanvasPersistLifecycleBridge` does for the
 * epic half of the strip. The store stays global; only its localStorage key is
 * switched per user, and a sign-out wipes the outgoing account's bucket so
 * the next account on this profile inherits no identity ids, titles or host
 * bindings it does not own.
 *
 * No legacy name: this store never shipped under an unscoped key, so there is
 * no pre-scoping bucket to adopt.
 *
 * Unlike the canvas, there is no desktop-side owner to defer to: the windows
 * bridge projects the STRIP layout per window, but the identity SOURCE records
 * live only here, so this bridge owns the bucket on every platform.
 */
export function IdentityTabsPersistLifecycleBridge(
  props: IdentityTabsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    if (transition.kind === "signedIn" || transition.kind === "userSwitched") {
      retargetPersistedStore({
        store: useIdentityTabsStore,
        name: identityTabsKey(transition.userId),
        legacyName: null,
      });
      return;
    }
    clearAndResetPersistedStore({
      store: useIdentityTabsStore,
      anonymousName: identityTabsKey(null),
    });
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  return <>{props.children}</>;
}
