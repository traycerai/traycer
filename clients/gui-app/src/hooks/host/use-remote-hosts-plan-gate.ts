import { useAuthStore } from "@/stores/auth/auth-store";
import { isPaidTier } from "@traycer/protocol/auth/user";

/**
 * Client-side mirror of CS's attach-grant paid-plan gate: remote host
 * connectivity is a paid-plan feature ("Sync and above" — every paid tier,
 * never the free plan). The server enforces this authoritatively on BOTH
 * attach-grant legs (`reason: "plan_restricted"`); this hook only drives the
 * presentation layer — disabled remote rows and the upgrade affordance —
 * instead of letting a free-plan user dial into a 403.
 *
 * Reads the auth store's `subscriptionStatus` projection (written at sign-in
 * and on every revalidation) rather than the `/v3/user` query: it is
 * synchronous, needs no `AuthService`/QueryClient in scope, and its `null`
 * (signed-out / not yet known) deliberately reads as NOT restricted — no
 * false upsell flash; evading the presentation gate just runs into the
 * server one.
 */
export function useRemoteHostsPlanRestricted(): boolean {
  const status = useAuthStore((s) => s.subscriptionStatus);
  return status !== null && !isPaidTier(status);
}
