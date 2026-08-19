import type { HostClientChangeEvent } from "@traycer-clients/shared/host-client/host-client";

/**
 * WHICH `HostClient` change events tear down the runtime messenger's binding.
 *
 * Extracted from `HostRuntimeProvider` so the filter is a thing a test can
 * hold. It was an inline closure, and an inline closure inside a provider
 * whose startup no suite gets through is a filter nothing can observe - which
 * is how it spent its whole life uncovered.
 *
 * `auth-changed` ONLY, and the exclusion is the point rather than the
 * inclusion. This used to run on every event without reading one, which was
 * survivable only because the active slot gated the announcing path: an
 * availability recovery on a host that was not the bound one never reached
 * here. Redesign P4.2 deleted that gate - `notifyHostAvailabilityRecovered`
 * names its host and announces for any of them - so an unfiltered listener
 * would reset the messenger and retire sessions on every durable-tab
 * heartbeat recovery, tearing down the very binding delivering the news.
 *
 * A credential identity transition is what the reset and the sweep were
 * always for: it invalidates the messenger's binding and retires sessions
 * held under the outgoing context. A recovery is not an identity event and
 * must change no bindings at all.
 */
export function buildRuntimeChangeScopeHandler(deps: {
  /** `RuntimeHostMessengerBinding.reset` — no-op when no runtime messenger. */
  readonly resetMessenger: () => void;
  /** The retired-context session sweep. */
  readonly sweepRetiredSessions: () => void;
}): (event: HostClientChangeEvent) => void {
  return (event) => {
    if (event.reason !== "auth-changed") {
      return;
    }
    deps.resetMessenger();
    deps.sweepRetiredSessions();
  };
}
