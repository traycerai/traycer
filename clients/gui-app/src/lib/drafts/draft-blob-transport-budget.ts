/**
 * How long the GUI waits for a `drafts.putBlob` response frame before
 * abandoning the upload.
 *
 * The transport's default unary budget is 30s, and that is a budget for a few
 * KB of JSON crossing a relay - not for a blob. A prepared image is at most
 * 3.75 MiB, which is ~5 MiB once base64 has inflated it, and every byte of it
 * rides ONE unary request: force-promoted to BULK past 1 MiB, paced by the
 * chunker, reassembled on the host, then parsed. On a 6 Mbps uplink the
 * serialization alone is ~7s of wire time that neither peer can see as
 * progress - there is no partial-response frame to reset a timer with - and a
 * loaded relay or a host mid-GC stretches it further. Under the default budget
 * a genuinely-succeeding upload is discarded client-side while the host goes
 * on to store the bytes, and the renderer then inlines base64 it did not need
 * to.
 *
 * Two minutes covers the worst modelled upload (5 MiB on a slow mobile uplink)
 * with margin, and is still short enough that a wedged put cannot hold the
 * draft mirror's blob lane for the rest of the session.
 *
 * MUST equal the `joinResponseTimeoutMs` declared for `drafts.putBlob` in
 * `host-method-policy-table.ts`: `HostClient.requestForWithOptions` validates
 * the caller's budget against the table and REJECTS any other value, so a
 * drift between the two is not a slow upload - it is every upload failing
 * before it is sent. A standalone leaf module (no imports of its own) is what
 * lets the policy table and the transport share one literal without a cycle
 * between them, the same shape `rate-limit-timing.ts` uses for
 * `host.getRateLimitUsage`.
 */
export const DRAFT_BLOB_PUT_RESPONSE_TIMEOUT_MS = 120_000;
