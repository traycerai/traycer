import { useCallback, useMemo, useRef, useState } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { createLocalMaintenanceFallbackClient } from "@/lib/host/local-maintenance-fallback-client";
import type {
  ActivateRefusalReason,
  ActivateResult,
  SelectionAuthorityClient,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { toast } from "sonner";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger } from "@/lib/logger";
import {
  deriveHostScopeStatus,
  type HostScopeStatus,
} from "@/components/settings/host-scope/host-scope-status";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import {
  findHostOption,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";

export interface HostScope {
  /** Every host this account owns or this client can dial, merged and sorted. */
  readonly hosts: readonly HostScopeOption[];
  /** The host being administered. `null` when there are no hosts, or `vanished`. */
  readonly host: HostScopeOption | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The id that was picked but is no longer listed — only when `vanished`. */
  readonly vanishedHostId: string | null;
  /** Drop an explicit pick and follow the active host again. */
  readonly returnToActive: () => void;
  /** The app-wide active host — where new work lands and the bell reads from. */
  readonly activeHostId: string | null;
  readonly activeHost: HostScopeOption | null;
  /** True when the administered host is also the active one. */
  readonly isViewingActive: boolean;
  readonly status: HostScopeStatus;
  readonly client: HostClient<HostRpcRegistry> | null;
  /**
   * True when `client` is the local-maintenance fallback decorator: the
   * scoped host is THIS machine's local host and the shell has a
   * `hostManagement` bridge, so the v1.2.0 maintenance RPCs a too-old host
   * negotiated away are served over the desktop CLI lane instead of degrading
   * (see `lib/host/local-maintenance-fallback-client.ts`). Enablement must
   * read this same flag (`resolveOverviewMethodDegrade`) so a control is
   * live exactly when the client would serve its method.
   */
  readonly localMaintenanceFallback: boolean;
  readonly setHostId: (hostId: string) => void;
  /**
   * ACTIVATE: the app's one and only writer of `preferredHostId` (selection
   * model §1, invariant 1). It does not bind anything here - it asks the
   * selection authority, which validates against the fleet, persists, and
   * re-derives; the new effective host comes back down to every window.
   */
  readonly makeActive: (hostId: string) => void;
  /**
   * An Activate is in flight. The button MUST gate on this.
   *
   * `makeActive` is fire-and-forget by shape, and the write behind it is not
   * cheap or idempotent-by-accident: `authority.activate` validates, persists
   * and re-derives, and a successful one fires the app's only `HostSelected`
   * analytics event. With the button live throughout, a double-click issued
   * two of each - two persists racing to decide the window's host, and a
   * duplicate event against a preference that landed once.
   */
  readonly isActivating: boolean;
  readonly isLoading: boolean;
  /**
   * A host list came back as an ERROR, so an empty `hosts` means "we could not
   * find out", not "you own no machines". The difference is the whole message:
   * one is recoverable by retrying, the other by installing a host.
   */
  readonly listsFailed: boolean;
  /** Re-request both host lists after a failure. */
  readonly retryLists: () => void;
  /** Reference "now" for relative timestamps; ticks once a minute. */
  readonly nowMs: number;
}

/**
 * WHERE a surface keeps its pick, handed in rather than imported, so the host
 * model below is not welded to one store.
 *
 * Settings owns the original (`settings-host-scope-store`, deliberately not
 * persisted); the header's usage popover owns a second, persisted one. They
 * are separate SELECTIONS on purpose — someone watching one machine's rate
 * limits has not thereby asked to administer it — but they must not become
 * separate host MODELS, because two answers to "what is this host called and
 * can I reach it" is exactly the drift `HostScopeOption` was introduced to
 * end. Everything below this line is therefore shared verbatim.
 */
export interface HostScopeSelection {
  /** `null` means "follow the active host" — not "no host". */
  readonly scopedHostId: string | null;
  /** `null` returns to following the active host. */
  readonly setScopedHostId: (hostId: string | null) => void;
}

/**
 * The one host-scope hook for Settings. Every host-scoped panel reads this and
 * nothing else, which is what makes the sidebar switcher authoritative rather
 * than one more picker among five.
 */
export function useHostScope(): HostScope {
  const scopedHostId = useSettingsHostScopeStore((s) => s.scopedHostId);
  const setScopedHostId = useSettingsHostScopeStore((s) => s.setScopedHostId);
  return useHostScopeFor({ scopedHostId, setScopedHostId });
}

/**
 * The host model itself, over whichever selection the caller owns. Splitting
 * this out from `useHostScope` was the whole change: the rules that make a
 * scope safe — `resolveScopedHost`'s refusal to silently retarget a vanished
 * pick, `transientClientEntry`'s `connectable` gate, `deriveHostScopeStatus` —
 * are properties of reading somebody else's host, not properties of Settings.
 * A second surface that re-derived them would eventually re-derive one of them
 * wrongly.
 */
export function useHostScopeFor(selection: HostScopeSelection): HostScope {
  const ambientClient = useHostClient();
  const runnerHost = useRunnerHost();
  // The list itself is shared with every other picker in the app — see
  // `useHostOptions`. What is left here is the SELECTION on top of it, which is
  // the only part Settings and the usage popover own.
  const options = useHostOptions();
  const { hosts, activeHostId, listsResolved, listsFailed, nowMs } = options;

  const { scopedHostId, setScopedHostId } = selection;
  const authority = runnerHost.selectionAuthority;
  // ONE activation at a time, and the guard is here rather than only on the
  // button: the button is one caller, and this is the seam every caller passes
  // through. `requestActivate` never rejects - it renders its own refusal and
  // transport arms as toasts - so the latch always clears.
  const [activatingHostId, setActivatingHostId] = useState<string | null>(null);
  // The GUARD is a ref and the flag is state, and they are not interchangeable.
  // Guarding on the state value reads it through this callback's closure, which
  // only refreshes on re-render - so two clicks delivered in one React batch
  // both see `null` and both write. That is precisely the double-click this
  // exists to stop, and it survived a state-only guard.
  const activatingRef = useRef(false);
  const makeActive = useCallback(
    (hostId: string) => {
      if (activatingRef.current) return;
      const option = findHostOption(hosts, hostId);
      activatingRef.current = true;
      setActivatingHostId(hostId);
      void requestActivate(authority, hostId, option).finally(() => {
        activatingRef.current = false;
        setActivatingHostId(null);
      });
    },
    [authority, hosts],
  );

  // Still loading is not the same as gone, and a list that FAILED cannot prove
  // a host was removed. Both rules — and the reason the `vanished` verdict is
  // never allowed to resolve silently to the active host — live in
  // `resolveScopedHost`, where a test can reach them.
  const resolved = useMemo(
    () =>
      resolveScopedHost({
        hosts,
        scopedHostId,
        activeHostId,
        listsResolved,
        listsFailed,
      }),
    [hosts, scopedHostId, activeHostId, listsResolved, listsFailed],
  );

  const host = resolved.host;
  const isFollowing =
    resolved.vanishedHostId === null &&
    host !== null &&
    host.hostId === activeHostId;

  // Gated on `connectable`, not on the entry's mere existence: an unavailable
  // entry can still carry a stale URL, and a plan-restricted remote advertises
  // one the server will refuse, so keying on the entry built a live-looking
  // client for a host the status machine was about to call `unreachable`.
  // The rule itself lives in `transientClientEntry`, where a test can reach it.
  const overrideEntry = useMemo(
    () => transientClientEntry(host, isFollowing),
    [isFollowing, host],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  // The transient client is built SYNCHRONOUSLY (`createRequester` is a Proxy),
  // so for a connectable host the only reason one comes back null is a missing
  // request context or unbound user. That is a credential gap, not a connection
  // in progress, and it must not render as a spinner that can never resolve.
  const hasRequestAuthority =
    ambientClient.getRequestContext() !== null &&
    ambientClient.getRequestContextUserId() !== null;

  const status = deriveHostScopeStatus({
    isFollowing,
    host,
    vanishedHostId: resolved.vanishedHostId,
    overrideClient,
    hasRequestAuthority,
    listsResolved,
  });

  // `overrideClient` is null for `connecting`, `unreachable` and `vanished`
  // — guaranteed by the `connectable` gate on `overrideEntry` above, not by
  // hope — so only the `following` branch may swap in the ambient client.
  // Any other branch handing back `ambientClient` would be the exact
  // substitution this status enum exists to make impossible.
  const resolvedClient =
    status === "following" ? ambientClient : overrideClient;

  // The local-maintenance fallback wrap, HERE and nowhere else: this is the
  // one point where every scope consumer's client is decided, so decorating
  // here is what guarantees the page's queries and mutations ride the
  // fallback — including the `following` state, whose binding names no host
  // and whose own `createRequesterForHostId` resolution would fall through
  // any decoration applied a level up. Fail-closed gates: this machine's
  // local host only (`isLocalMachine ?? false` is the row's own fail-closed
  // read), and only where a `hostManagement` bridge exists (never in a
  // browser shell, never for a remote scope).
  const fallbackHostId =
    host !== null && host.isLocalMachine ? host.hostId : null;
  const hostManagement = runnerHost.hostManagement;
  const client = useMemo(() => {
    if (
      resolvedClient === null ||
      fallbackHostId === null ||
      hostManagement === null
    ) {
      return resolvedClient;
    }
    return createLocalMaintenanceFallbackClient({
      client: resolvedClient,
      localHostId: fallbackHostId,
      management: hostManagement,
    });
  }, [resolvedClient, fallbackHostId, hostManagement]);

  return {
    hosts,
    host,
    hostId: host?.hostId ?? null,
    hostLabel: host?.name ?? resolved.vanishedHostId ?? "No host",
    vanishedHostId: resolved.vanishedHostId,
    returnToActive: () => setScopedHostId(null),
    activeHostId,
    activeHost: findHostOption(hosts, activeHostId),
    isViewingActive: isFollowing,
    status,
    client,
    localMaintenanceFallback: client !== null && client !== resolvedClient,
    setHostId: setScopedHostId,
    makeActive,
    isActivating: activatingHostId !== null,
    isLoading: options.isLoading,
    listsFailed,
    retryLists: options.retryLists,
    nowMs,
  };
}

/**
 * The Activate write, with its refusal arms rendered (F14/D13).
 *
 * Exported for its own test: this IS the "only Settings writes preferred"
 * acceptance seam, and reaching it through `useHostScopeFor` would mean
 * standing up the whole Settings provider tree to observe one call and one
 * toast - the panels' own tests mock this module wholesale for exactly that
 * reason. `makeActive` is the one-line wiring that calls it.
 *
 * `ok: true` resolves only after the authority validated, persisted, and
 * re-derived, so the analytics event below is fired against a preference that
 * actually landed - and it is the ONLY `HostSelected` in the app now. A
 * refusal is a real answer about a host, not a transport failure, so each one
 * says what the user can do about it instead of a generic error.
 *
 * Deliberately not refused by the authority, and therefore never toasted
 * here: a registered host that is currently OFFLINE. Preferred is intent, not
 * liveness (D1/D5) - derivation serves a fallback until it returns.
 */
export async function requestActivate(
  authority: SelectionAuthorityClient,
  hostId: string,
  option: HostScopeOption | null,
): Promise<void> {
  let result: ActivateResult;
  try {
    result = await authority.activate(hostId);
  } catch (error: unknown) {
    appLogger.warn("[host-scope] activate request failed", {
      hostId,
      error: String(error),
    });
    toast.error("Couldn't activate this host. Try again.");
    return;
  }
  if (result.ok) {
    Analytics.getInstance().track(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: option?.isLocalMachine === true ? "local" : "remote",
    });
    return;
  }
  toast.error(
    activateRefusalMessage(result.reason, option?.name ?? "That host"),
  );
}

/**
 * One line of copy per refusal arm, as a total map over the CONTRACT's union
 * rather than a hand-written copy of it.
 *
 * A `Record` keyed on `ActivateRefusalReason` is the census: the day the
 * contract grows a sixth arm, this object fails to compile with the missing
 * key named, instead of silently routing a new refusal into the generic
 * fallback and telling the user nothing about a reason the engine took the
 * trouble to distinguish. That is exactly how `persist-failed` arrived.
 *
 * Two families, and the split matters for the copy: `unknown-host` /
 * `incompatible` are statements ABOUT THE HOST and name it; `not-attached` /
 * `persist-failed` are failures of this window's own machinery, where naming
 * the host would misattribute the fault to a machine that is fine.
 */
const ACTIVATE_REFUSAL_COPY: Record<
  ActivateRefusalReason,
  (label: string) => string
> = {
  "unknown-host": (label) =>
    `${label} is no longer registered to this account.`,
  incompatible: (label) =>
    `${label} needs a host update before it can be activated.`,
  "not-attached": () =>
    "This window lost its connection to the selection service - reload and try again.",
  // Nothing moved: the preference was refused BEFORE any state changed and no
  // event fired, so the same Activate is safe to retry verbatim - which is why
  // this says "try again" and not "it may or may not have applied".
  "persist-failed": () => "Couldn't save your choice - try again.",
  unrecognized: (label) => `Couldn't activate ${label}.`,
};

function activateRefusalMessage(
  reason: ActivateRefusalReason,
  label: string,
): string {
  return ACTIVATE_REFUSAL_COPY[reason](label);
}
