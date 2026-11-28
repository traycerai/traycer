import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { HostIdentityGetResponse } from "@traycer/protocol/host/identity/schemas";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostMaintenanceMutationKeys } from "@/lib/query-keys";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { TEAM_MEMBERSHIP_REQUIRED_MESSAGE } from "@traycer-clients/shared/host-transport/local-open-auth";
import { hostDoorStateFor } from "@/stores/host/host-door-state-store";
import { DOOR_STATE_TITLES } from "@/lib/host/door-state-titles";
import { useSignOutConfirmStore } from "@/stores/auth/sign-out-confirm-store";
import { createLocalMaintenanceFallbackClient } from "@/lib/host/local-maintenance-fallback-client";
import type {
  ActivateRefusalReason,
  ActivateResult,
  SelectionAuthorityClient,
} from "@traycer-clients/shared/host-selection/selection-authority-contract";
import { toast } from "sonner";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useRequestContextUserId } from "@/hooks/host/use-request-context-user-id";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useRunnerHost } from "@/providers/use-runner-host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger } from "@/lib/logger";
import { UNNAMED_HOST_LABEL } from "@/hooks/agent/use-host-reachability";
import {
  deriveHostScopeStatus,
  hostListedOffline,
  hostRowDemotion,
  isHostScopeUsable,
  type HostScopeStatus,
} from "@/components/settings/host-scope/host-scope-status";
import {
  useHostOptions,
  type HostOptions,
} from "@/components/settings/host-scope/use-host-options";
import { useSettingsHostScopeStore } from "@/stores/settings/settings-host-scope-store";
import { useHostsRunningConfiguration } from "@/components/settings/environment/use-hosts-running-configuration";
import { useSettingsHostEntry } from "@/components/settings/host-scope/use-settings-host-entry";
import {
  environmentPickValue,
  type EnvironmentPick,
} from "@/lib/settings-environment-pages";
import {
  useEnvironmentPick,
  useSettingsEnvironmentPickStore,
} from "@/stores/settings/settings-environment-pick-store";
import { useHostReadRefusal } from "@/components/settings/host-scope/use-host-read-refusal";
import { hostRowHealth } from "@/components/settings/host-scope/host-health";
import {
  findHostOption,
  resolveScopedHost,
  transientClientEntry,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import {
  hostOptionCanActivate,
  TEAM_HOST_ACTIVATE_REASON,
} from "@/components/settings/host-scope/host-option-model";

export interface HostScope {
  /** The surface's options, with the global host facts preserved. */
  readonly hosts: readonly HostScopeOption[];
  /** The host being administered. `null` when there are no hosts, or `vanished`. */
  readonly host: HostScopeOption | null;
  readonly hostId: string | null;
  readonly hostLabel: string;
  /** The id that was picked but is no longer listed — only when `vanished`. */
  readonly vanishedHostId: string | null;
  /** Settings remembers the selected name after its membership row leaves. */
  readonly vanishedSelection: {
    readonly name: string;
    readonly forget: () => void;
  } | null;
  /** Drop an explicit pick and follow the active host again. */
  readonly returnToActive: () => void;
  /**
   * The scope follows its page's pick and nothing on the page can re-point it
   * (`WINDOW_HOST_SELECTION`, `usePersonalHostScope`): `setHostId` and
   * `returnToActive` do nothing, so no notice offers them.
   */
  readonly readOnly: boolean;
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
   * ACTIVATE: the app's one and only writer of `preferredHostId`.
   * It does not bind anything here - it asks the
   * selection authority, which validates against the fleet, persists, and
   * re-derives; the new effective host comes back down to every window.
   */
  readonly makeActive: (hostId: string) => Promise<boolean>;
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
  /** Retry a failed status read while a Settings host entry stays pending. */
  readonly retryEntryStatus: (() => void) | null;
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
  /**
   * Following, and the active host not listed once the lists settle: the
   * first computer, for a surface whose own host picker can change it, or no
   * host (`resolveScopedHost`).
   */
  readonly defaultsToFirstHost: boolean;
  /**
   * A computer the HOSTS list shows offline reads `unreachable` at once,
   * without this surface dialling it on its own: only the Environment pages
   * under a Local pick. Every other surface keeps riding out the relay fuse
   * grace with its own dial.
   */
  readonly offlineReadsAway: boolean;
}

/** The Settings Host scope, with what only Settings knows of its host. */
export interface SettingsHostScope extends HostScope {
  /**
   * The host is shown from its account row alone while Settings still waits
   * to place it (`hostRowDemotion`): no environment is known to run it.
   */
  readonly shownFromRow: boolean;
}

/**
 * The picked environment's host selection, shared by the rail and host panels.
 *
 * While it waits on a computer it can name (a pending entry's, or the
 * window's own while no environment is chosen and its default is unresolved)
 * that the app cannot read, the scope is that computer's account row
 * (`hostRowDemotion`), listed once with the environment's members, rather
 * than a wait that cannot end. The wait itself, and every pick, pin and
 * entry rule, are unchanged.
 */
export function useHostScope(): SettingsHostScope {
  const options = useHostOptions();
  const pick = useEnvironmentPick();
  const pendingHostId = useSettingsHostScopeStore((s) => s.pendingHostId);
  const pendingAct = useSettingsHostScopeStore((s) => s.pendingAct);
  const selection = useSettingsHostScopeStore(
    (s) => s.hostByEnvironment[environmentPickValue(pick)] ?? null,
  );
  const environmentPicked = useSettingsEnvironmentPickStore(
    (s) => s.pick !== null,
  );
  const selectHost = useSettingsHostScopeStore((s) => s.selectHost);
  const entry = useSettingsHostEntry();
  const configurationPicked = pick.kind === "personal" || pick.kind === "team";
  const membership = useHostsRunningConfiguration(
    configurationPicked ? pick : { kind: "personal" },
    configurationPicked,
  );
  const membershipState = settingsMembershipState(pick, membership.state);
  const ready = membershipState === "ready";
  const members = useMemo(() => {
    if (!ready) return [];
    const memberIds = new Set(
      pick.kind === "local"
        ? [pick.hostId]
        : membership.hosts.map((host) => host.hostId),
    );
    return options.hosts.filter((host) => memberIds.has(host.hostId));
  }, [ready, pick, membership.hosts, options.hosts]);
  const retryLists = (): void => {
    options.retryLists();
    membership.retry();
    entry.retry();
  };
  const mainOptions = settingsMainOptions({
    options,
    members,
    pendingHostId,
    ready,
    membershipState,
    entryFailed: entry.failed,
    retryLists,
  });
  const waited = findHostOption(
    options.hosts,
    settingsWaitedHostId({
      mainWaiting: mainOptions.isLoading && !mainOptions.listsFailed,
      entryUndecided: entry.undecided,
      defaultResolved: entry.defaultResolved,
      pendingHostId,
      pinned: selection !== null,
      environmentPicked,
      pick,
      activeHostId: options.activeHostId,
    }),
  );
  const refusal = useHostReadRefusal(waited?.hostId ?? null);
  const demotion = hostRowDemotion({
    host: waited,
    readRefused: refusal.refused,
    outdated: refusal.outdated,
  });
  const { nowMs } = options;
  const fromRow = useMemo(
    () =>
      waited === null || demotion === null
        ? null
        : {
            ...waited,
            connectable: false,
            health: hostRowHealth({
              demotion,
              health: waited.health,
              item: waited.item,
              nowMs,
            }),
          },
    [waited, demotion, nowMs],
  );
  const hosts = useMemo(
    () => settingsRowHosts(fromRow, members, mainOptions.hosts),
    [fromRow, members, mainOptions.hosts],
  );
  const setScopedHostId = useCallback(
    (hostId: string | null) => {
      if (fromRow !== null) {
        settingsRowWrite({
          hostId,
          fromRow,
          hosts,
          pendingHostId,
          pendingAct,
          pick,
        });
        return;
      }
      if (hostId === null) {
        selectHost(pick, null);
        return;
      }
      const host = findHostOption(hosts, hostId);
      if (host !== null) selectHost(pick, { hostId, name: host.name });
    },
    [pick, selectHost, hosts, fromRow, pendingHostId, pendingAct],
  );
  const scope = useHostScopeWithOptions(
    {
      scopedHostId:
        fromRow?.hostId ?? (selection ?? hosts.at(0))?.hostId ?? null,
      setScopedHostId,
      defaultsToFirstHost: true,
      offlineReadsAway: false,
    },
    fromRow === null ? mainOptions : { ...options, hosts, retryLists },
  );
  return {
    ...scope,
    retryEntryStatus: settingsScopeRetry(
      demotion,
      refusal.retryStatus,
      entry.retryStatus,
    ),
    activeHost: findHostOption(options.hosts, options.activeHostId),
    vanishedSelection:
      scope.vanishedHostId !== null && selection !== null
        ? { name: selection.name, forget: () => selectHost(pick, null) }
        : null,
    shownFromRow: fromRow !== null,
  };
}

const NO_HOSTS: readonly HostScopeOption[] = [];

/** Main's lists: the members, and a wait while a named entry is pending. */
function settingsMainOptions(input: {
  readonly options: HostOptions;
  readonly members: readonly HostScopeOption[];
  readonly pendingHostId: string | null;
  readonly ready: boolean;
  readonly membershipState: "ready" | "loading" | "failed";
  readonly entryFailed: boolean;
  readonly retryLists: () => void;
}): HostOptions {
  const { options, pendingHostId } = input;
  return {
    ...options,
    hosts: pendingHostId === null ? input.members : NO_HOSTS,
    listsResolved:
      options.listsResolved && input.ready && pendingHostId === null,
    listsFailed:
      options.listsFailed ||
      input.membershipState === "failed" ||
      input.entryFailed,
    isLoading:
      options.isLoading ||
      input.membershipState === "loading" ||
      (pendingHostId !== null && !input.entryFailed),
    retryLists: input.retryLists,
  };
}

/**
 * The rows the Settings scope offers: while it shows the computer it waits on
 * from its account row, the environment's members with that row once, in its
 * own place or after them; otherwise main's.
 */
function settingsRowHosts(
  fromRow: HostScopeOption | null,
  members: readonly HostScopeOption[],
  mainHosts: readonly HostScopeOption[],
): readonly HostScopeOption[] {
  if (fromRow === null) return mainHosts;
  return findHostOption(members, fromRow.hostId) === null
    ? [...members, fromRow]
    : members.map((host) => (host.hostId === fromRow.hostId ? fromRow : host));
}

/**
 * A pick made while the scope shows a computer from its row. Picking that
 * computer again is already the view; pinning it would end the wait that
 * places it. Returning to the active host (after the computer was removed
 * from the account, say) ends only the wait main is in, and only the named
 * entry this callback was made for: a late call never ends a request made
 * since, for this computer or another. It never clears a pin the person made
 * for another computer. Any other row is picked as main picks it.
 */
function settingsRowWrite(input: {
  readonly hostId: string | null;
  readonly fromRow: HostScopeOption;
  readonly hosts: readonly HostScopeOption[];
  readonly pendingHostId: string | null;
  readonly pendingAct: number;
  readonly pick: EnvironmentPick;
}): void {
  const { hostId } = input;
  const store = useSettingsHostScopeStore.getState();
  if (hostId === null) {
    if (input.pendingHostId !== null && store.pendingAct === input.pendingAct)
      store.abandonHostEntry(input.pendingHostId);
    return;
  }
  if (hostId === input.fromRow.hostId) return;
  const host = findHostOption(input.hosts, hostId);
  if (host !== null) store.selectHost(input.pick, { hostId, name: host.name });
}

/**
 * The status retry the scope offers: main's entry retry, or for a computer
 * shown from its row after a refused read, that computer's status read again.
 * An outdated computer has none: reading it again cannot change its version.
 */
function settingsScopeRetry(
  demotion: "needs-update" | "refused" | null,
  rowRetry: () => void,
  entryRetry: (() => void) | null,
): (() => void) | null {
  if (demotion === null) return entryRetry;
  return demotion === "refused" ? rowRetry : null;
}

/**
 * The computer the Settings scope waits on and can already name: a pending
 * entry's, or the window's own while nothing is pinned, no environment was
 * picked and the default has not resolved. Only while main itself waits in
 * this render, by the entry's own outcome or the default this render knows: a
 * wait it ends (placed, abandoned, failed, defaulted) is never overridden,
 * even on the render before its write lands.
 */
function settingsWaitedHostId(input: {
  readonly mainWaiting: boolean;
  readonly entryUndecided: boolean;
  readonly defaultResolved: boolean;
  readonly pendingHostId: string | null;
  readonly pinned: boolean;
  readonly environmentPicked: boolean;
  readonly pick: EnvironmentPick;
  readonly activeHostId: string | null;
}): string | null {
  if (!input.mainWaiting) return null;
  if (input.pendingHostId !== null)
    return input.entryUndecided ? input.pendingHostId : null;
  if (input.pinned || input.environmentPicked || input.defaultResolved)
    return null;
  return input.pick.kind === "unresolved" ? input.activeHostId : null;
}

/**
 * Environment and Account pages never read through the Host picker: a pick
 * made under the Host group never changes what they show, and nothing on them
 * can re-point it - the setter is a no-op.
 *
 * Account pages follow the person, so they read through the window's own
 * host: the active host, and no host while the lists have not listed it,
 * never another computer in its place. Environment pages
 * read through the host the Environment dropdown names: a Local row's
 * computer, and the window's own host for Personal when that host runs it.
 * A team, and Personal on a window whose host does not run it, read the
 * cloud instead (`PersonalPageFrame`).
 */
export const WINDOW_HOST_SELECTION: HostScopeSelection = {
  scopedHostId: null,
  setScopedHostId: noScopedHostWrite,
  defaultsToFirstHost: false,
  offlineReadsAway: false,
};

function noScopedHostWrite(): void {
  return undefined;
}

export function usePersonalHostScope(): HostScope {
  const pick = useEnvironmentPick();
  const localHostId = pick.kind === "local" ? pick.hostId : null;
  const selection = useMemo(
    (): HostScopeSelection => ({
      scopedHostId: localHostId,
      setScopedHostId: noScopedHostWrite,
      defaultsToFirstHost: false,
      offlineReadsAway: localHostId !== null,
    }),
    [localHostId],
  );
  return useHostScopeFor(selection);
}

/** The window's own host, for Account pages. */
export function useAccountHostScope(): HostScope {
  return useHostScopeFor(WINDOW_HOST_SELECTION);
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
  return useHostScopeWithOptions(selection, useHostOptions());
}

function useHostScopeWithOptions(
  selection: HostScopeSelection,
  options: HostOptions,
): HostScope {
  const ambientClient = useHostClient();
  const runnerHost = useRunnerHost();
  const { hosts, activeHostId, listsResolved, listsFailed, nowMs } = options;

  const { scopedHostId, setScopedHostId, defaultsToFirstHost } = selection;
  const { makeActive, isActivating } = useMakeActiveHost(hosts);

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
        defaultsToFirstHost,
      }),
    [
      hosts,
      scopedHostId,
      activeHostId,
      listsResolved,
      listsFailed,
      defaultsToFirstHost,
    ],
  );

  const host = resolved.host;
  const isFollowing =
    resolved.vanishedHostId === null &&
    host !== null &&
    host.hostId === activeHostId;

  // Gated on `connectable`, not on the entry's mere existence: an unavailable
  // entry can still carry a stale URL, so keying on the entry built a
  // live-looking client for a host the status machine was about to call `unreachable`.
  // The rule itself lives in `transientClientEntry`, where a test can reach it.
  // A remote computer the HOSTS list shows offline, on a surface that reads
  // it as away: no client is built for it, so nothing here dials it.
  const listedOffline =
    selection.offlineReadsAway && host !== null && hostListedOffline(host);
  const overrideEntry = useMemo(
    () => transientClientEntry(listedOffline ? null : host, isFollowing),
    [isFollowing, host, listedOffline],
  );
  const overrideClient = useHostClientFor(overrideEntry);

  // The transient client is built SYNCHRONOUSLY (`createRequester` is a Proxy),
  // so for a connectable host the only reason one comes back null is a missing
  // request context or unbound user. That is a credential gap, not a connection
  // in progress, and it must not render as a spinner that can never resolve.
  const hasRequestAuthority = useRequestContextUserId(ambientClient) !== null;

  const status = deriveHostScopeStatus({
    isFollowing,
    host,
    vanishedHostId: resolved.vanishedHostId,
    overrideClient,
    hasRequestAuthority,
    listsResolved,
    listedOffline,
  });

  // `overrideClient` is null for `connecting`, `unreachable` and `vanished`
  // — guaranteed by the `connectable` gate on `overrideEntry` above, not by
  // hope — so only the `following` branch may swap in the ambient client.
  // Any other branch handing back `ambientClient` would be the exact
  // substitution this status enum exists to make impossible.
  const scopedClient = status === "following" ? ambientClient : overrideClient;
  const resolvedClient = isHostScopeUsable(status) ? scopedClient : null;

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
    // A vanished pick is a host nothing lists any more: nothing names it.
    hostLabel:
      host?.name ??
      (resolved.vanishedHostId === null ? "No host" : UNNAMED_HOST_LABEL),
    vanishedHostId: resolved.vanishedHostId,
    vanishedSelection: null,
    returnToActive: () => setScopedHostId(null),
    readOnly: setScopedHostId === noScopedHostWrite,
    activeHostId,
    activeHost: findHostOption(hosts, activeHostId),
    isViewingActive: isFollowing,
    status,
    client,
    localMaintenanceFallback: client !== null && client !== resolvedClient,
    setHostId: setScopedHostId,
    makeActive,
    isActivating,
    isLoading: options.isLoading,
    listsFailed,
    retryLists: options.retryLists,
    retryEntryStatus: null,
    nowMs,
  };
}

/**
 * The activation in flight, per authority: ONE `authority.activate` at a time
 * for the whole window, whichever surface asked (R1-A2).
 *
 * It lives here, at module level, and not in the hook, because the hook's
 * callers come and go while a write is still running: the account menu's Host
 * section unmounts the moment a pick closes the menu, and Settings holds an
 * instance of its own. A latch per mounted hook was a latch per surface, so a
 * reopened menu - or Settings beside it - sent a second write before the first
 * settled. Keyed by the authority so a window's writes share it and nothing
 * else does. The entry is set synchronously before the write goes out (two
 * picks in one React batch still see it) and cleared when the write settles;
 * `requestActivate` never rejects, so it always does.
 */
const pendingActivations = new WeakMap<SelectionAuthorityClient, string>();
const pendingActivationListeners = new Set<() => void>();

function notifyPendingActivation(): void {
  for (const listener of Array.from(pendingActivationListeners)) listener();
}

function subscribePendingActivation(listener: () => void): () => void {
  pendingActivationListeners.add(listener);
  return () => {
    pendingActivationListeners.delete(listener);
  };
}

/**
 * Settings' Activate, as a hook of its own so the account menu's Host section
 * (the one other place a person switches the window's host) calls the SAME
 * write, guard, refusal toasts and analytics, rather than a second copy.
 * `activatingHostId` is the write in flight from ANY surface, so every caller
 * can hold its controls while one is running.
 */
export function useMakeActiveHost(hosts: readonly HostScopeOption[]): {
  readonly makeActive: (hostId: string) => Promise<boolean>;
  readonly isActivating: boolean;
  readonly activatingHostId: string | null;
} {
  const authority = useRunnerHost().selectionAuthority;
  const hostClient = useHostClient();
  const { mutateAsync: probeLocalHost } = useHostMutation<
    HostRpcRegistry,
    "host.identity.get",
    unknown,
    HostScopeOption
  >({
    client: (option) =>
      option.entry === null ? null : hostClient.createRequester(option.entry),
    method: "host.identity.get",
    mapVariables: () => ({}),
    options: {
      mutationKey: hostMaintenanceMutationKeys.identityGet(),
      retry: false,
    },
  });
  const activatingHostId = useSyncExternalStore(
    subscribePendingActivation,
    () => pendingActivations.get(authority) ?? null,
  );
  const makeActive = useCallback(
    (hostId: string) => {
      if (pendingActivations.has(authority)) return Promise.resolve(false);
      const option = findHostOption(hosts, hostId);
      // Defence for every caller, not only the Overview that hides the
      // button: a management-only row is never made the window's host.
      if (option !== null && !hostOptionCanActivate(option)) {
        appLogger.debug("[host-scope] activate refused: management-only host", {
          hostId,
        });
        return Promise.resolve(false);
      }
      pendingActivations.set(authority, hostId);
      notifyPendingActivation();
      const activation =
        option?.connectable && option.entry?.kind === "local"
          ? requestLocalHostActivation(
              authority,
              hostClient,
              option,
              probeLocalHost,
            )
          : requestActivate(authority, hostId, option);
      return activation.finally(() => {
        pendingActivations.delete(authority);
        notifyPendingActivation();
      });
    },
    [authority, hostClient, hosts, probeLocalHost],
  );
  return {
    makeActive,
    isActivating: activatingHostId !== null,
    activatingHostId,
  };
}

/**
 * An explicit local pick must ask the local door even when its old lease is
 * dead. Persisting preference alone can keep a ready remote host serving, so
 * the effective-host streams never try this computer and never explain its
 * admission refusal. This one read uses the existing request authority and
 * grant adapter; automatic selection and background work do not call it.
 */
async function requestLocalHostActivation(
  authority: SelectionAuthorityClient,
  client: HostClient<HostRpcRegistry>,
  option: HostScopeOption,
  probe: (option: HostScopeOption) => Promise<HostIdentityGetResponse>,
): Promise<boolean> {
  const context = client.getRequestContext();
  if (context === null || option.entry === null) return false;
  try {
    await probe(option);
  } catch {
    // A different account must not inherit this account's refusal or pick.
    if (context.abortSignal.aborted || client.getRequestContext() !== context)
      return false;
    showLocalHostActivationFailure(option.hostId, option.name, () => {
      if (
        !context.abortSignal.aborted &&
        client.getRequestContext() === context
      )
        useSignOutConfirmStore.getState().setOpen(true);
    });
    return false;
  }
  if (context.abortSignal.aborted || client.getRequestContext() !== context)
    return false;
  return requestActivate(authority, option.hostId, option);
}

function showLocalHostActivationFailure(
  hostId: string,
  hostName: string,
  switchAccount: () => void,
): void {
  const doorState = hostDoorStateFor(hostId)?.kind;
  if (doorState === "not-a-member") {
    toast.error(TEAM_MEMBERSHIP_REQUIRED_MESSAGE, {
      action: {
        label: "Switch account",
        onClick: switchAccount,
      },
    });
    return;
  }
  if (doorState === "token-unavailable" || doorState === "token-expired") {
    toast.error(DOOR_STATE_TITLES[doorState]);
    return;
  }
  toast.error(activateRefusalMessage("unrecognized", hostName));
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
 * recognized refusal says what the user can do about it. `unrecognized`
 * covers a failed call or an unreadable answer: the choice may already have
 * persisted, so its words make no claim about which machine is active.
 *
 * Deliberately not refused by the authority, and therefore never toasted
 * here: a registered host that is currently OFFLINE. Preferred is intent, not
 * liveness (D1/D5) - derivation serves a fallback until it returns.
 */
export async function requestActivate(
  authority: SelectionAuthorityClient,
  hostId: string,
  option: HostScopeOption | null,
): Promise<boolean> {
  let result: ActivateResult;
  try {
    result = await authority.activate(hostId);
  } catch (error: unknown) {
    // Like an unreadable answer, a failed call leaves the outcome unknown.
    // `unrecognized` makes no claim about which machine is active.
    appLogger.warn("[host-scope] activate request failed", {
      hostId,
      error: String(error),
    });
    toast.error(
      activateRefusalMessage("unrecognized", option?.name ?? "that machine"),
    );
    return false;
  }
  if (result.ok) {
    // Preferred is intent, not liveness: a sleeping sandbox is now preferred,
    // so it is woken, and derivation serves a fallback until it is up.
    if (option !== null) wakeSandboxOnPick(option, null);
    Analytics.getInstance().track(AnalyticsEvent.HostSelected, {
      source: "direct_ui",
      host_kind: option?.isLocalMachine === true ? "local" : "remote",
    });
    return true;
  }
  toast.error(
    activateRefusalMessage(result.reason, option?.name ?? "that machine"),
  );
  return false;
}

/**
 * One line of copy per refusal arm, as a total map over the CONTRACT's union
 * rather than a hand-written copy of it.
 *
 * A `Record` keyed on `ActivateRefusalReason` is the census: the day the
 * contract grows another arm, this object fails to compile with the missing
 * key named, instead of silently routing a new refusal into the generic
 * fallback and telling the user nothing about a reason the engine took the
 * trouble to distinguish. That is exactly how `persist-failed` arrived.
 */
const ACTIVATE_REFUSAL_COPY: Record<
  ActivateRefusalReason,
  (label: string) => string
> = {
  "unknown-host": () =>
    "It's gone from your account. The previous machine stays active.",
  incompatible: () => "Update the app to use this machine.",
  "team-host": () => TEAM_HOST_ACTIVATE_REASON,
  "not-attached": () => "Try again in a moment.",
  // Nothing moved: the preference was refused BEFORE any state changed and no
  // event fired, so the same Activate is safe to retry verbatim - which is why
  // this says "try again" and not "it may or may not have applied".
  "persist-failed": () =>
    "The choice didn't stick — the previous machine stays active. Try again.",
  // A failed call or an unreadable answer leaves the outcome unknown, so
  // this makes no claim about which machine is active.
  unrecognized: (label) =>
    `Couldn't confirm ${label} as the app's machine. Check which machine is active, then try again.`,
};

function activateRefusalMessage(
  reason: ActivateRefusalReason,
  label: string,
): string {
  return ACTIVATE_REFUSAL_COPY[reason](label);
}

/** A Local pick needs no membership; an unresolved pick cannot claim its result. */
function settingsMembershipState(
  pick: EnvironmentPick,
  state: "ready" | "loading" | "failed",
): "ready" | "loading" | "failed" {
  if (pick.kind === "local") return "ready";
  if (pick.kind === "unresolved") return "loading";
  return state;
}
