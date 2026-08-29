import { use, useMemo } from "react";
import type { IHostStreamClient } from "@traycer-clients/shared/host-transport/host-stream-client";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import {
  useHostNegotiatedMethodVersions,
  type NegotiatedMethodVersion,
} from "@/hooks/host/use-host-negotiated-method-version";
import {
  useStreamMethodSchemaVersionFor,
  useStreamMethodSupportFor,
} from "@/lib/host/stream-runtime-context";
import { NotificationFeedModeContext } from "@/lib/notifications/notification-feed-mode-context";

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

/**
 * Negotiates the feed mode against ONE explicit stream client.
 *
 * A cloud-capable host is mixed-plane only once all durable-home projections
 * negotiated. An older host may advertise the relay but still expose whole
 * origin summaries; selecting both there would double-count replicas. In that
 * case local remains the single safe view until the host upgrades.
 *
 * FOUR methods are consulted, across BOTH transports, because RPC versions are
 * negotiated per method and the two stream minors do not imply the two unary
 * ones. Mixed mode is not only a subscription choice: it makes
 * `useMergedNotificationsActions` send `home: "local"` as a partition selector
 * on `host.notifications.list` and `host.notifications.markAllRead`. A host
 * below `list@2.2` / `markAllRead@1.1` parses those requests against its
 * frozen schema and STRIPS that selector, so pagination merges whole-origin
 * cloud replicas into the cloud lane and mark-all reaches cloud-home rows the
 * user never saw. Selecting mixed mode on the stream minors alone is what
 * makes an unsupported selector look accepted.
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
  const hasPartitionedList =
    hostId !== null &&
    meetsNegotiatedFloor(listVersions.get(hostId) ?? null, 2, 2);
  const hasPartitionedMarkAllRead =
    hostId !== null &&
    meetsNegotiatedFloor(markAllReadVersions.get(hostId) ?? null, 1, 1);
  return cloudFeedSupport === "supported" &&
    hasCloudProjection &&
    hasLocalProjection &&
    hasPartitionedList &&
    hasPartitionedMarkAllRead
    ? "cloud"
    : "local";
}
