import { z } from "zod";

import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  listTaskLightSchemaPre18,
  listTasksCompletenessSchemaPre16,
  taskFiltersSchema,
} from "@traycer/protocol/host/epic/unary-schemas";

/**
 * `epic.localHistory.read`: what only this host knows about the person's
 * History, with no cloud call. The app reads History's pages from the server
 * pool and composes this contribution into them:
 *
 * - `localHomeRows` - tasks whose durable home is this machine (unpromoted,
 *   or mid-promotion). A local-home row WINS its id over a pool row: its home
 *   is the routing truth while the cloud copy may still be uploading. Ordered
 *   by the caller's own view recency.
 * - `preservedRows` - cloud-homed tasks whose delete was refused to protect
 *   edits never uploaded (`preservation: "orphaned-local-edits"`). These only
 *   FILL A GAP: a pool row for the same id stands, since the server is the
 *   authority for a cloud-homed task.
 * - `tombstonedEpicIds` - tasks this person deleted on this host whose delete
 *   the server may not have seen yet (offline, or by the CLI while the app was
 *   closed). Applied to EVERY page, cursor pages included, and before a cached
 *   page paints: a pool page that still lists one must not resurrect it.
 *
 * The positive rows answer the request's `filters` with the same evidence
 * rules as the host's own History arm, and only for the first page: they are
 * exempt from cursor paging and totals. `localRows` says what the positive
 * rows are, with the vocabulary of `epic.listTasks`' completeness statement.
 *
 * Completeness is a separate, positive statement. `complete: false` means the
 * host could not read its local store, so the rows AND the tombstones above are
 * empty without proving anything; the app must not paint a page that this
 * contribution would have changed. `willComplete` then says whether waiting
 * helps: `true` while the store may still open (the host is booting, or its
 * fence is being retried), `false` once it has refused or failed, when the app
 * treats the host as unable to contribute and states the reduced coverage.
 *
 * `awaitComplete: true` asks a host whose store may still open to hold its
 * answer until it has opened or settled as unavailable, so a caller that read
 * `complete: false, willComplete: true` learns the outcome from one waiting
 * read instead of asking again on a timer.
 *
 * Optional (non-floor): a host that predates it answers `E_HOST_UNSUPPORTED`
 * for this call alone, and the app treats such a host as unable to contribute.
 */
export const localHistoryReadRequestSchema = lazySchema(() =>
  z.object({
    filters: taskFiltersSchema.nullable(),
    awaitComplete: z.boolean(),
  }),
);
export type LocalHistoryReadRequest = z.infer<
  typeof localHistoryReadRequestSchema
>;

export const localHistoryReadResponseSchema = lazySchema(() =>
  z.object({
    complete: z.boolean(),
    willComplete: z.boolean(),
    localHomeRows: z.array(listTaskLightSchemaPre18),
    preservedRows: z.array(listTaskLightSchemaPre18),
    tombstonedEpicIds: z.array(z.string()),
    localRows: listTasksCompletenessSchemaPre16.shape.localRows,
  }),
);
export type LocalHistoryReadResponse = z.infer<
  typeof localHistoryReadResponseSchema
>;
