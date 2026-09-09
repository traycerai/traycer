import { use, useMemo, useState } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  useHostNegotiatedMethodVersions,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import {
  useStreamMethodSchemaVersionFor,
  useStreamMethodSupportFor,
} from "@/lib/host/stream-runtime-context";
import {
  NotificationFeedModeContext,
  NotificationFeedModeSettlingContext,
} from "@/lib/notifications/notification-feed-mode-context";

export type NotificationFeedMode = "local" | "cloud" | "upgrade-required";

const NO_HOST_IDS: readonly string[] = [];

/**
 * Whether a negotiated UNARY version meets a floor on its own major line.
 *
 * Both non-version states answer `false`, and the difference between them does
 * not matter here: `false` is a host that did not advertise the method and
 * `null` is a host whose handshake has not been recorded yet, and mixed mode
 * is unsafe under either. That is the safe direction for this particular gate
 * only because `null` is self-correcting - the registry records every unary
 * ack, so a host that merely has not been asked yet resolves on its next RPC
 * and the mode flips `local` -> `cloud` through the transition the provider
 * already handles. Do not copy this collapse into a decision that could STRAND
 * data; see `useHostNegotiatedMethodVersion` for why those must keep the two
 * apart.
 *
 * Exact major, matching the stream reads below: these methods' majors are
 * separate contract lines rather than a monotonic scale.
 */
function meetsNegotiatedFloor(
  version: NegotiatedMethodVersion,
  major: number,
  minor: number,
): boolean {
  if (version === null || version === false) return false;
  return version.major === major && version.minor >= minor;
}

/**
 * The same floor, resolved for ONE host out of a per-host manifest map.
 *
 * `hostId === null` is `false` for the reason the map lookup is: with no host
 * there is no manifest to have negotiated anything, and mixed mode is unsafe
 * under an unknown just as under a refusal. Folded into one helper because
 * three call sites repeating `hostId !== null &&` is three chances to write the
 * fourth one without it.
 */
function meetsHostFloor(
  versions: ReadonlyMap<string, NegotiatedMethodVersion>,
  hostId: string | null,
  major: number,
  minor: number,
): boolean {
  if (hostId === null) return false;
  return meetsNegotiatedFloor(versions.get(hostId) ?? null, major, minor);
}

/**
 * The negotiated feed mode for the host the notification streams are OPEN on.
 *
 * Read from context rather than recomputed per call site. The capability read
 * has to name the exact client `NotificationsSessionProvider` opened the
 * streams against - `useReactiveLocalHostEntry()`, which is deliberately not
 * the app-wide active host - and `useHostStreamClientFor` builds a client per
 * hook instance, so recomputing it in each of the ~8 consumers would both dial
 * spare clients and, worse, read the wrong host's manifest.
 *
 * Defaults to `local` outside the provider: that is the single safe view, the
 * same answer an incomplete negotiation gives.
 */
export function useNotificationFeedMode(): NotificationFeedMode {
  return use(NotificationFeedModeContext);
}

/** See `NotificationFeedModeSettlingContext`. */
export function useNotificationFeedModeSettling(): boolean {
  return use(NotificationFeedModeSettlingContext);
}

interface HeldNotificationFeedMode {
  readonly servingHostId: string | null;
  readonly negotiated: NotificationFeedMode;
  readonly cloudFeedSupport: StreamMethodSupport | null;
  readonly settled: NotificationFeedMode;
  readonly settling: boolean;
}

export interface HeldNotificationFeedModeResult {
  /** The mode consumers render and decide on. */
  readonly mode: NotificationFeedMode;
  /**
   * `true` while `mode` is a held `cloud` and the same host's handshake has
   * not landed. The hold keeps the rows and the lanes; it must NOT keep
   * sending the `home: "local"` partition selector, because the host coming
   * back can be a ROLLBACK to a release below the five-method floor - one
   * that negotiates lower per-method versions and strips the selector, so a
   * `list` merges whole-origin rows into the cloud lane and a mark-all reaches
   * cloud-home rows the user never saw. So partition-dependent unary calls
   * (`useMergedNotificationsActions`' pagination and mark-all, the mixed-mode
   * indicator queries) wait for this to clear; the new handshake either
   * reconfirms `cloud` or settles to `local`, and both resume them.
   */
  readonly settling: boolean;
}

/**
 * The negotiated mode, HELD across a stream client's re-negotiation.
 *
 * A rebuilt stream client reports every method's support as `unknown` until
 * its handshake lands, so `useNotificationFeedModeFor` reads `local` for a
 * beat even when the same cloud-capable host is coming right back. That beat
 * is "not yet re-decided", not a capability downgrade. The session body used
 * to apply this hold privately, inside its stream-transition effect - which
 * left every OTHER consumer of the mode context (`useMergedNotificationsActions`,
 * the indicator hooks, the sidebar) reading the raw `local` for that beat:
 * a `list` fired then omitted the `home: "local"` partition selector, and a
 * mark-all reached cloud-home rows. The hold therefore lives here, in the
 * value the shell publishes, so the session body and the context agree.
 *
 * `null` support (no client at all) is NOT held: there is no handshake in
 * flight to wait for, and the negotiated `local` is the genuine answer.
 *
 * Held for the SAME serving host only. The hold exists for a rebuild of one
 * host's client; a relay-only shell can also switch its serving host from A
 * to B, and B's fresh client reports `unknown` for the same beat. Carrying
 * A's `cloud` across that switch would have every consumer send the
 * `home: "local"` partition selector on B's unary calls before B's own
 * negotiation said B supports it - and an older B strips the selector, so
 * whole-origin rows merge into the cloud lane and a mark-all reaches
 * cloud-home rows (the exact failure the five-method floor in
 * `useNotificationFeedModeFor` exists to prevent). So a host change settles
 * to B's raw negotiation - `local`, the single safe view - and B's own
 * handshake re-decides from there.
 *
 * Derived state, adjusted during render rather than in an effect: the settled
 * mode must be visible in the same commit as the negotiation change, or the
 * beat this exists to remove would still reach one render's worth of
 * consumers.
 */
export function useHeldNotificationFeedMode(
  negotiated: NotificationFeedMode,
  cloudFeedSupport: StreamMethodSupport | null,
  servingHostId: string | null,
): HeldNotificationFeedModeResult {
  const [held, setHeld] = useState<HeldNotificationFeedMode>({
    servingHostId,
    negotiated,
    cloudFeedSupport,
    settled: negotiated,
    settling: false,
  });
  if (
    held.servingHostId !== servingHostId ||
    held.negotiated !== negotiated ||
    held.cloudFeedSupport !== cloudFeedSupport
  ) {
    const sameHost = held.servingHostId === servingHostId;
    const holding = sameHost && cloudFeedSupport === "unknown";
    const settled = holding ? held.settled : negotiated;
    // Only a held `cloud` is a liability: a held `local` sends no selector.
    const settling = holding && settled === "cloud";
    setHeld({ servingHostId, negotiated, cloudFeedSupport, settled, settling });
    return { mode: settled, settling };
  }
  return { mode: held.settled, settling: held.settling };
}

/**
 * Negotiates the feed mode against ONE explicit stream client.
 *
 * A cloud-capable host is mixed-plane only once all durable-home projections
 * negotiated. An older host may advertise the relay but still expose whole
 * origin summaries; selecting both there would double-count replicas. In that
 * case local remains the single safe view until the host upgrades.
 *
 * FIVE methods are consulted, across BOTH transports, because RPC versions are
 * negotiated per method and the two stream minors do not imply the three unary
 * ones. Mixed mode is not only a subscription choice: it makes
 * `useMergedNotificationsActions` send `home: "local"` as a partition selector
 * on `host.notifications.list` and `host.notifications.markAllRead`, and
 * `useNotificationIndicators` send it on `host.notifications.indicatorState`.
 * A host below `list@2.2` / `markAllRead@1.1` / `indicatorState@1.1` parses
 * those requests against its frozen schema and STRIPS that selector, so
 * pagination merges whole-origin cloud replicas into the cloud lane, mark-all
 * reaches cloud-home rows the user never saw, and the indicator flags answer
 * for the whole origin. Selecting mixed mode on the stream minors alone is what
 * makes an unsupported selector look accepted.
 *
 * `indicatorState` is the quietest of the three and the reason this floor is
 * checked HERE rather than left to the wire. `list@2.2` refuses its own
 * downgrade (`hostNotificationsListDowngradeV22ToV10`), so a peer below it
 * fails loudly; `home` is merely an OPTIONAL field on the `@1.1` indicator
 * request, so an `@1.0` peer drops it and answers plausibly. Mixed mode then
 * ORs those whole-origin flags into the cloud projection as though they were an
 * exact local partition - and per-flag OR is licensed ONLY by the two
 * partitions being disjoint (see `useNotificationIndicators`). Stale cloud-home
 * read/action state keeps tabs and sidebar rows lit, with nothing to catch it.
 *
 * `hostId` names the host whose unary manifest to read and must be the SAME
 * host `client` is bound to - passing the app-wide host here would gate a
 * remote host's lanes on the local host's capabilities.
 */
export function useNotificationFeedModeFor(
  client: IHostStreamClient<HostStreamRpcRegistry> | null,
  hostId: string | null,
): NotificationFeedMode {
  const cloudFeedSupport = useStreamMethodSupportFor(
    client,
    "host.notifications.cloudFeed.subscribe",
  );
  const cloudFeedVersion = useStreamMethodSchemaVersionFor(
    client,
    "host.notifications.cloudFeed.subscribe",
  );
  const localFeedVersion = useStreamMethodSchemaVersionFor(
    client,
    "host.notifications.feed.subscribe",
  );
  const partitionHostIds = useMemo(
    (): readonly string[] => (hostId === null ? NO_HOST_IDS : [hostId]),
    [hostId],
  );
  const listVersions = useHostNegotiatedMethodVersions(
    partitionHostIds,
    "host.notifications.list",
  );
  const markAllReadVersions = useHostNegotiatedMethodVersions(
    partitionHostIds,
    "host.notifications.markAllRead",
  );
  const indicatorStateVersions = useHostNegotiatedMethodVersions(
    partitionHostIds,
    "host.notifications.indicatorState",
  );
  /**
   * `>= 2`, NOT `>= 1`: the cloud feed's `partitionSnapshot` arm lives on
   * `@1.2`. It was authored as `@1.1` and re-minted when mainline shipped its
   * own `@1.1` (the widened `entry` union), so `@1.1` is a whole-origin feed.
   *
   * The floor cannot be relaxed to "parses successfully", because a `@1.1`
   * peer's whole-origin `snapshot` DOES parse against the `@1.2` frame union -
   * that arm is still in it - and `cloud-notifications-store` applies it
   * through the same `applySnapshot` case as `partitionSnapshot`. So admitting
   * `@1.1` here puts every local-homed row in BOTH lanes and double-counts it
   * in the summary. The host is already correct on its side and serves such a
   * peer the whole relay feed; this is the half that decides whether to ask.
   */
  const hasCloudProjection =
    cloudFeedVersion?.major === 1 && cloudFeedVersion.minor >= 2;
  const hasLocalProjection =
    localFeedVersion?.major === 1 && localFeedVersion.minor >= 2;
  const hasPartitionedList = meetsHostFloor(listVersions, hostId, 2, 2);
  const hasPartitionedMarkAllRead = meetsHostFloor(
    markAllReadVersions,
    hostId,
    1,
    1,
  );
  const hasPartitionedIndicatorState = meetsHostFloor(
    indicatorStateVersions,
    hostId,
    1,
    1,
  );
  return cloudFeedSupport === "supported" &&
    hasCloudProjection &&
    hasLocalProjection &&
    hasPartitionedList &&
    hasPartitionedMarkAllRead &&
    hasPartitionedIndicatorState
    ? "cloud"
    : "local";
}
