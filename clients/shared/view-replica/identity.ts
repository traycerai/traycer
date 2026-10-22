import { canonicalForMethodVersionLine } from "@traycer/protocol/framework/compat-helpers";
import type { ManifestRegistry } from "@traycer/protocol/framework/capability-manifest";
import {
  hostRpcRegistry,
  hostStreamRpcRegistry,
} from "@traycer/protocol/host/registry";
import type {
  HostStreamRpcMethod,
  HostUnaryRpcMethod,
} from "../host-client/host-rpc-routing";

/**
 * The epoch of the index a page was read from, qualified by its source: the
 * serving tier that minted it. Opaque to the client; only equality is read.
 * A reindex (a new epoch) makes every page cached under the old one a miss,
 * because a row cached against a superseded index can name positions the new
 * one does not have.
 */
export interface ViewReplicaSourceEpoch {
  readonly source: string;
  readonly value: string;
}

/**
 * Where a cached page lives, as the caller names it. The store completes it
 * into a {@link ViewReplicaIdentity} with the two members only it may supply:
 * the source epoch it last observed and the client's canonical version.
 */
export interface ViewReplicaAddress {
  /** The signed-in account. First on purpose: no read crosses accounts. */
  readonly accountId: string;
  /** The logical service: the RPC method that answers the page. */
  readonly service: string;
  /**
   * The tier that answers (`hostRpcServingTierHostId`): the pool's id for a
   * pool-only family in a build with a pool, else the host's. Never a pool
   * instance, and never flips with reachability.
   */
  readonly servingTier: string;
  /** The request, canonically serialized ({@link viewReplicaRequestScope}). */
  readonly requestScope: string;
}

/**
 * A cached page's whole identity. Two pages are the same page only when every
 * member is equal; any difference is a miss, never a page projected onto the
 * other's shape.
 */
export interface ViewReplicaIdentity extends ViewReplicaAddress {
  readonly sourceEpoch: ViewReplicaSourceEpoch | null;
  /**
   * The client's canonical `major.minor` for `service` when the page was
   * written. The wire decode path upgrades a response to the client
   * canonical; nothing upgrades bytes read back from disk, so a page written
   * by an older client is a miss for a newer one.
   */
  readonly canonicalVersion: string;
}

/** The storage key: every identity member, account first. */
export function viewReplicaKey(identity: ViewReplicaIdentity): string {
  return JSON.stringify([
    identity.accountId,
    identity.service,
    identity.servingTier,
    identity.requestScope,
    identity.sourceEpoch === null
      ? null
      : [identity.sourceEpoch.source, identity.sourceEpoch.value],
    identity.canonicalVersion,
  ]);
}

/** The key without the epoch and version: the slot those two compete for. */
export function viewReplicaSlotKey(address: ViewReplicaAddress): string {
  return JSON.stringify([
    address.accountId,
    address.service,
    address.servingTier,
    address.requestScope,
  ]);
}

export function sameViewReplicaIdentity(
  left: ViewReplicaIdentity,
  right: ViewReplicaIdentity,
): boolean {
  return viewReplicaKey(left) === viewReplicaKey(right);
}

/**
 * A request serialized with its object keys sorted, so two requests that
 * differ only in key order name the same page.
 */
export function viewReplicaRequestScope(request: unknown): string {
  return JSON.stringify(sortKeys(request));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const member: unknown = Reflect.get(value, key);
    if (member !== undefined) sorted[key] = sortKeys(member);
  }
  return sorted;
}

const UNARY_LINES: ManifestRegistry = hostRpcRegistry;
const STREAM_LINES: ManifestRegistry = hostStreamRpcRegistry;

/** This client's canonical version of a unary method. */
export function clientUnaryCanonicalVersion(
  method: HostUnaryRpcMethod,
): string {
  return formatCanonical(UNARY_LINES, method);
}

/** This client's canonical version of a stream method. */
export function clientStreamCanonicalVersion(
  method: HostStreamRpcMethod,
): string {
  return formatCanonical(STREAM_LINES, method);
}

function formatCanonical(lines: ManifestRegistry, method: string): string {
  const version = canonicalForMethodVersionLine(lines[method], method);
  return `${version.major}.${version.minor}`;
}
