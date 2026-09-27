/**
 * The composer can keep a discovered command for this long. Send preparation
 * may reuse a compatible catalog for the same window plus the maximum age of
 * the host answer the composer originally received. Explicit refresh/config
 * changes still invalidate caches; picker reads retain their shorter lifetime.
 */
export const COMMAND_CATALOG_COMPOSER_STALE_MS = 15 * 60 * 1_000;
export const COMMAND_CATALOG_DISCOVERY_CACHE_MS = 60 * 1_000;
