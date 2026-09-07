import type {
  ConnectionManifest,
  VersionedRpcRegistry,
} from "@traycer/protocol/framework/index";
import {
  buildConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";

/**
 * Version manifest for a unary `VersionedRpcRegistry` - one canonical `{ major, minor }` plus every installed major per method.
 * Narrowing it to what some peer can serve would make the frozen support matrix a statement about one client's implementation rather than about the contract set.
 */
export function buildManifestFromRegistry(
  registry: VersionedRpcRegistry,
): ConnectionManifest {
  return buildConnectionManifest(registry, SERVES_EVERY_INSTALLED_MAJOR);
}
