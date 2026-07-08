import { useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  PROVIDER_DISPLAY_NAMES,
  TUI_HARNESS_ID_TO_PROVIDER_ID,
  type ProviderCliState,
  type ProviderId,
} from "@traycer/protocol/host/provider-schemas";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import { useTabProvidersList } from "@/hooks/providers/use-tab-providers-list-query";

// The harness id set is a superset of the provider-CLI id set (it also carries
// `traycer`, which has no provider-CLI login). Only CLI harnesses gate. Grok,
// Qwen, Kiro, Kimi, Droid, Copilot, and Kilo Code are GUI-only (not in the TUI map)
// but DO gate through their CLI login providers, mirroring the host's
// `harnessIdToProviderId`. Exported so other harness->provider derivations
// (e.g. the chat provider rate-limit selector) share this single mapping.
export function providerIdForHarness(
  harnessId: GuiHarnessId,
): ProviderId | null {
  if (harnessId === "traycer") return null;
  if (harnessId === "openrouter") return "openrouter";
  if (harnessId === "grok") return "grok";
  if (harnessId === "qwen") return "qwen";
  if (harnessId === "kiro") return "kiro";
  if (harnessId === "droid") return "droid";
  if (harnessId === "kimi") return "kimi";
  if (harnessId === "copilot") return "copilot";
  if (harnessId === "kilocode") return "kilocode";
  if (harnessId === "amp") return "amp";
  return TUI_HARNESS_ID_TO_PROVIDER_ID[harnessId];
}

export interface ProviderReauthGate {
  readonly providerId: ProviderId | null;
  readonly state: ProviderCliState | null;
  readonly signedOut: boolean;
}

/**
 * Connection-level auth gate for the composer's currently-selected provider,
 * scoped to the tab's host. This replaces the per-message re-auth card: auth
 * is a property of `(tabHost, provider)`, not of any one turn, so the live
 * affordance lives here (above the composer) and derives purely from current
 * provider state - no `isLatestTurn`, no per-segment resolution store, no latch.
 *
 * `signedOut` is a pure predicate: a *definitive* probe `unauthenticated`. A
 * transient `unknown` does not flip it (no flicker on the host probe's race);
 * the host poison (`markProviderUnauthenticated`, written the instant it
 * detects a credential failure) guarantees a definitive `unauthenticated` after
 * a real failure, so there is no renderer-side "last turn failed" flag to carry
 * - the `code: "auth"` stream frame drives a plain `providers.list` invalidate
 * and the refetch reads the poison.
 *
 * The gate intentionally does NOT auto-force-refresh on activate: a bare
 * force-refresh bypasses the host poison and re-runs the flaky standalone
 * probe, which on a pure subscription reports `authenticated` while the run
 * 401s - flipping `signedOut` off and flickering the banner. Re-checks are
 * user-driven (the banner's Refresh button) or driven by the next failing
 * run's poison. An external `claude /logout` while the composer was unmounted
 * therefore surfaces on the next send (which re-poisons) or a manual Refresh.
 */
export function useProviderReauthGate(
  harnessId: GuiHarnessId,
  active: boolean,
): ProviderReauthGate {
  const providerId = providerIdForHarness(harnessId);
  const enabled = active && providerId !== null;
  const query = useTabProvidersList({ enabled, subscribed: enabled });

  const state =
    query.data?.providers.find((p) => p.providerId === providerId) ?? null;
  const signedOut = enabled && state?.auth.status === "unauthenticated";

  // Bookend the reconnect loop with one-shot toasts: a notice when the provider
  // first goes signed-out (the failure has no transcript row - it's suppressed
  // as a connection condition - so this is the transient "why did nothing
  // happen?" acknowledgement), and a success when it returns. Feedback, not
  // stored state: the banner still mounts/unmounts purely from `signedOut`, so
  // nothing here resurrects the old per-segment "resolved" memory.
  //
  // The latch holds the *provider* that was signed out, not a bool, so each edge
  // fires exactly once. A token paste makes the host re-probe, emitting a
  // transient `unknown` between paste and verdict; a bool reset on every render
  // would clear during that gap and double-fire. Holding the provider id also
  // means a provider the user merely *switched to* (already authenticated) never
  // phantom-fires, and deactivating the composer (`state` -> null) can't either.
  const authStatus = state?.auth.status ?? null;
  const signedOutProviderRef = useRef<ProviderId | null>(null);
  useEffect(() => {
    if (signedOut) {
      if (signedOutProviderRef.current !== providerId) {
        signedOutProviderRef.current = providerId;
        toast.error(`${PROVIDER_DISPLAY_NAMES[providerId]} is signed out`);
      }
    } else if (
      authStatus === "authenticated" &&
      providerId !== null &&
      signedOutProviderRef.current === providerId
    ) {
      signedOutProviderRef.current = null;
      toast.success(`${PROVIDER_DISPLAY_NAMES[providerId]} reconnected`);
    }
  }, [signedOut, authStatus, providerId]);

  return { providerId, state, signedOut };
}
