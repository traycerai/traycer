import type {
  ConnectionManifest,
  SchemaVersion,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import { canonicalForMethodVersionLine } from "@traycer/protocol/framework/compat-helpers";

/**
 * Canonical manifest for a unary `VersionedRpcRegistry` - one `{ major,
 * minor }` per method, always the highest installed minor of the highest
 * installed major. Structurally the unary counterpart of `buildStreamManifest`
 * in `./stream-compat` (which does the same projection for the `/stream`
 * registry family).
 *
 * This is release-engineering/tooling surface, not a runtime dependency: the
 * real `/rpc` client transport (`clients/shared/host-transport/ws-rpc-client.ts`)
 * builds its own manifest inline via the same `canonicalForMethodVersionLine`
 * primitive rather than importing this function. `buildManifestFromRegistry`
 * exists so release tooling - `scripts/snapshot-support-matrix.ts` and the
 * `two-sided-release-invariant` test - can derive the CURRENT registry's
 * manifest once and compare it against frozen historical support-matrix
 * entries without duplicating the projection logic between the two.
 */
export function buildManifestFromRegistry(
  registry: VersionedRpcRegistry,
): ConnectionManifest {
  const manifest: Record<string, SchemaVersion> = {};
  for (const method of Object.keys(registry)) {
    manifest[method] = canonicalForMethodVersionLine(registry[method], method);
  }
  return manifest;
}
