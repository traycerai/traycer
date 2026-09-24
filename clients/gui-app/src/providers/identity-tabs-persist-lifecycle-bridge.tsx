import { useCallback, useEffect, type ReactNode } from "react";
import { useIdentityTabsStore } from "@/stores/identities/identity-tabs-store";
import {
  isIdentityTabsHydrated,
  markIdentityTabsHydrated,
} from "@/stores/identities/identity-tabs-hydration";
import { identityTabsKey } from "@/lib/persist";
import { useAuthStore } from "@/stores/auth/auth-store";
import {
  useAuthIdentityTransition,
  type AuthIdentityTransition,
} from "@/hooks/auth/use-auth-identity-transition";
import {
  detachPersistedStore,
  retargetPersistedStore,
} from "@/lib/persist/zustand-persist-lifecycle";

export interface IdentityTabsPersistLifecycleBridgeProps {
  readonly children: ReactNode;
}

/**
 * Retargets the persisted Identities-tab bucket whenever the signed-in
 * account changes, the way `EpicCanvasPersistLifecycleBridge` does for the
 * epic half of the strip. The store stays global; only its localStorage key is
 * switched per user. A sign-out DETACHES rather than wipes: the store moves to
 * the anonymous bucket with empty state, so the next account on this profile
 * inherits no identity ids, titles or host bindings, while the outgoing
 * account's bucket stays on disk and is restored when it signs back in.
 *
 * No legacy name: this store never shipped under an unscoped key, so there is
 * no pre-scoping bucket to adopt.
 *
 * Unlike the canvas, there is no desktop-side owner to defer to: the windows
 * bridge projects the STRIP layout per window, but the identity SOURCE records
 * live only here, so this bridge owns the bucket on every platform - and it
 * is therefore also what marks the store hydrated for the account
 * (`identity-tabs-hydration.ts`), the signal the desktop layout restore and
 * the history pruner wait on instead of the anonymous bucket's own
 * `hasHydrated()`.
 */
export function IdentityTabsPersistLifecycleBridge(
  props: IdentityTabsPersistLifecycleBridgeProps,
): ReactNode {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.profile?.userId ?? null);

  const onTransition = useCallback((transition: AuthIdentityTransition) => {
    try {
      if (
        transition.kind === "signedIn" ||
        transition.kind === "userSwitched"
      ) {
        retargetPersistedStore({
          store: useIdentityTabsStore,
          name: identityTabsKey(transition.userId),
          legacyName: null,
        });
        return;
      }
      detachPersistedStore({
        store: useIdentityTabsStore,
        anonymousName: identityTabsKey(null),
      });
    } finally {
      markIdentityTabsHydrated();
    }
  }, []);

  useAuthIdentityTransition(status, userId, onTransition);

  useEffect(() => {
    // This bridge mounts after HostRuntimeProvider awaits auth.start(). An
    // initially signed-out session emits no identity transition, but the
    // anonymous bucket IS the account's answer then, so hydration completes.
    // A held sign-in attempt (`signing-in`) is not a settled answer and waits.
    if (status !== "signed-out" || isIdentityTabsHydrated()) return;
    markIdentityTabsHydrated();
  }, [status]);

  return <>{props.children}</>;
}
