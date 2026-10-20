import { z } from "zod";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import {
  hostNotificationsCloudFeedRowSchemaV13,
  hostNotificationsCloudFeedSummarySchema,
  type HostNotificationsCloudFeedRowV13,
  type HostNotificationsCloudFeedSummary,
} from "@traycer/protocol/host/notifications/contracts";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  clientStreamCanonicalVersion,
  viewReplicaRequestScope,
  type ViewReplicaAddress,
} from "@traycer-clients/shared/view-replica/identity";
import { ACCOUNT_ROW_SCOPE } from "@traycer-clients/shared/view-replica/row-scope";
import { ViewReplicaService } from "@traycer-clients/shared/view-replica/service";
import { viewReplicaStore } from "@/lib/view-replica/view-replica-store";

const SERVICE = "host.notifications.cloudFeed.subscribe";

/** The account notification feed as the list and the badge paint it. */
export interface NotificationFeedReplicaPage {
  readonly rows: readonly HostNotificationsCloudFeedRowV13[];
  readonly summary: HostNotificationsCloudFeedSummary;
  /**
   * The `cloudFeed.subscribe` version the serving tier negotiated when this
   * snapshot arrived: a fact about that tier at write time. It answers the
   * feed mode's cloud-projection floor while the tier's own client has not
   * negotiated yet (see `useNotificationFeedModeFor`).
   */
  readonly cloudFeedVersion: SchemaVersion | null;
}

const shellSchema = z.object({
  summary: hostNotificationsCloudFeedSummarySchema,
  cloudFeedVersion: z
    .object({
      major: z.number().int().nonnegative(),
      minor: z.number().int().nonnegative(),
    })
    .nullable(),
});
const rowsSchema = z.array(hostNotificationsCloudFeedRowSchemaV13);

/**
 * The cloud notification feed in the replica tier. Every row is the
 * account's: the feed is the person's own, whichever host minted an entry.
 * The feed's change sequence is the page's generation, so a snapshot older
 * than the one held is never written over it.
 *
 * Painting it on a cold start with the pool unreachable puts the feed in
 * cloud mode from the stored version, so the list is these rows beside the
 * host's `home: "local"` partition. Stated cost: cloud-home rows this host
 * minted after the replica's snapshot wait for the pool's answer while the
 * host's own cloud lane serves (the partition is then empty); while it does
 * not, the partition is the whole origin and a row in both lanes shows twice
 * until the first snapshot replaces the cached rows.
 */
export const notificationFeedReplicaService =
  new ViewReplicaService<NotificationFeedReplicaPage>({
    service: SERVICE,
    canonicalVersion: clientStreamCanonicalVersion(SERVICE),
    split: (page) => ({
      shell: { summary: page.summary, cloudFeedVersion: page.cloudFeedVersion },
      rows: page.rows.map((row) => ({ scope: ACCOUNT_ROW_SCOPE, value: row })),
    }),
    join: (shell, rows) => {
      const parsedShell = shellSchema.safeParse(shell);
      const parsedRows = rowsSchema.safeParse(rows);
      if (!parsedShell.success || !parsedRows.success) return null;
      return {
        rows: parsedRows.data,
        summary: parsedShell.data.summary,
        cloudFeedVersion: parsedShell.data.cloudFeedVersion,
      };
    },
    asCached: (page) => page,
  });

/**
 * The replica address of the feed served for `servingHostId`: the pool's in a
 * build with one, whichever host serves the window.
 */
export function notificationFeedReplicaAddress(
  accountId: string,
  servingHostId: string | null,
): ViewReplicaAddress | null {
  const servingTier = hostRpcServingTierHostId(
    SERVICE,
    servingHostId,
    readProcessHostRpcTierPlan(),
    null,
  );
  if (servingTier === null) return null;
  return {
    accountId,
    service: SERVICE,
    servingTier,
    requestScope: viewReplicaRequestScope({}),
  };
}

/** Records an accepted snapshot of the feed. */
export function rememberNotificationFeed(input: {
  readonly accountId: string;
  readonly servingHostId: string | null;
  readonly page: NotificationFeedReplicaPage;
  readonly version: number;
}): void {
  const address = notificationFeedReplicaAddress(
    input.accountId,
    input.servingHostId,
  );
  if (address === null) return;
  viewReplicaStore.write(notificationFeedReplicaService, address, input.page, {
    observedAt: Date.now(),
    sourceGeneration: input.version,
  });
}

/**
 * A feed write (read, clear) was confirmed. A snapshot is stamped when it
 * arrives, so one sent before the write can arrive after it: the feed version
 * held when the write was sent (`feedVersion`, the cloud's per-user change
 * sequence) is what marks every snapshot at or below it as older.
 */
export function noteNotificationFeedConfirmedWrite(
  accountId: string,
  feedVersion: number | null,
): void {
  viewReplicaStore.noteConfirmedWrite(accountId, SERVICE, {
    at: Date.now(),
    generation: feedVersion,
  });
}
