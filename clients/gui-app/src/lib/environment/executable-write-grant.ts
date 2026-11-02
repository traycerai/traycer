import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import type { ExecutableWriteGrantFetchResult } from "@traycer-clients/shared/host-client/executable-write-grant";
import type { HostRpcRegistry } from "@/lib/host";
import { appLogger } from "@/lib/logger";

/**
 * The executable-write grant, minted here and nowhere else in the app.
 *
 * A write that can reach an execution sink on a host (a shell, a
 * launch-sensitive variable, an MCP server with a command, a skill, a command
 * hook) carries `executableWriteGrant`. On a host bound to the person's
 * environment the host forwards that write to the environment, and the
 * environment applies it on every bound host only with a grant the person's
 * own session minted for that host. So the app mints one, on the user session
 * (`AuthService.mintExecutableWriteGrant`, ten minutes, one host), and sends
 * it; the host only attaches it.
 *
 * `null` is a real answer, not a failure to handle: on a host without an
 * environment there is nothing to authorize, and when a mint fails the write
 * still goes, and the host holds it as "needs you" for the person to apply.
 * Neither case blocks the write.
 */

export interface ExecutableWriteGrantMinter {
  mintExecutableWriteGrant(
    hostId: string,
  ): Promise<ExecutableWriteGrantFetchResult>;
  /**
   * Advances on every change of the session's credential, including a sign-in
   * on the same minter after a sign-out.
   */
  getCredentialGeneration(): number;
}

interface CachedGrant {
  readonly grant: string;
  readonly reuseUntil: number;
  /** The credential generation the grant was minted under. */
  readonly generation: number;
}

/**
 * A grant is reused until this long before it expires, so one minted for a
 * burst of edits covers them and none is sent with seconds left on it.
 */
const GRANT_REUSE_MARGIN_MS = 60_000;

/**
 * One cache per minter. A minter outlives a sign-out and the next sign-in, so
 * each grant also records the credential it was minted under, and a grant from
 * an earlier credential is never sent: the account may have revoked it.
 */
const grantCaches = new WeakMap<
  ExecutableWriteGrantMinter,
  Map<string, CachedGrant>
>();

function cacheFor(
  minter: ExecutableWriteGrantMinter,
): Map<string, CachedGrant> {
  const existing = grantCaches.get(minter);
  if (existing !== undefined) return existing;
  const created = new Map<string, CachedGrant>();
  grantCaches.set(minter, created);
  return created;
}

/**
 * Whether `client`'s host is bound to an environment, from its own
 * `environment.status`. A host that cannot answer (a version without
 * environments, or one that is unreachable) is treated as not bound: its
 * write is not forwarded, so it needs no grant.
 */
async function hostHasEnvironment(
  client: HostRequester<HostRpcRegistry>,
): Promise<boolean> {
  try {
    const status = await client.request("environment.status", {});
    return status.principal !== null;
  } catch {
    return false;
  }
}

/**
 * The grant to send with a sink-reaching write to `client`'s host, or `null`.
 */
export async function resolveExecutableWriteGrant(
  minter: ExecutableWriteGrantMinter,
  client: HostRequester<HostRpcRegistry>,
  now: () => number,
): Promise<string | null> {
  const hostId = client.getActiveHostId();
  if (hostId === null) return null;
  if (!(await hostHasEnvironment(client))) return null;
  const cache = cacheFor(minter);
  const generation = minter.getCredentialGeneration();
  const cached = cache.get(hostId);
  if (
    cached !== undefined &&
    cached.generation === generation &&
    cached.reuseUntil > now()
  ) {
    return cached.grant;
  }
  cache.delete(hostId);
  const result = await minter.mintExecutableWriteGrant(hostId);
  // The credential changed while the mint was in flight: the grant is the
  // earlier credential's, so it is neither kept nor sent.
  if (minter.getCredentialGeneration() !== generation) return null;
  if (result.kind !== "ok") {
    // The outcome only; the write goes on without a grant.
    appLogger.debug("executable-write grant not minted", {
      outcome: result.kind,
    });
    return null;
  }
  cache.set(hostId, {
    grant: result.grant,
    reuseUntil: now() + result.expiresInSeconds * 1_000 - GRANT_REUSE_MARGIN_MS,
    generation,
  });
  return result.grant;
}

/** The request with its grant filled in. */
export async function withExecutableWriteGrant<
  Request extends { readonly executableWriteGrant: string | null },
>(
  minter: ExecutableWriteGrantMinter | null,
  client: HostRequester<HostRpcRegistry>,
  request: Request,
): Promise<Request> {
  if (minter === null) return request;
  const grant = await resolveExecutableWriteGrant(minter, client, Date.now);
  return { ...request, executableWriteGrant: grant };
}
