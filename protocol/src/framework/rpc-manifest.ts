import type {
  ConnectionManifest,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  buildConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";

/**
 * Version manifest for a unary `VersionedRpcRegistry` - one canonical
 * `{ major, minor }` plus every installed major per method. Structurally the
 * unary counterpart of `buildStreamManifest` in `./stream-compat` (which does
 * the same projection for the `/stream` registry family).
 *
 * This is release-engineering/tooling surface, not a runtime dependency: the
 * real `/rpc` client transport (`clients/shared/host-transport/ws-rpc-client.ts`)
 * uses `splitConnectionManifest` directly. `buildManifestFromRegistry` exists
 * so release tooling - `scripts/snapshot-support-matrix.ts` and the
 * `two-sided-release-invariant` test - can derive the CURRENT registry's
 * manifest once and compare it against frozen historical support-matrix
 * entries without duplicating the projection logic between the two.
 *
 * Deliberately unrestricted: this answers "what does the registry install",
 * which is the question release tooling asks. Narrowing it to what some peer
 * can serve would make the frozen support matrix a statement about one
 * client's implementation rather than about the contract set.
 */
export function buildManifestFromRegistry(
  registry: VersionedRpcRegistry,
): ConnectionManifest {
  return buildConnectionManifest(registry, SERVES_EVERY_INSTALLED_MAJOR);
}
