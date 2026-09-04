/**
 * Test fixtures for the shared `RequestContext`.
 *
 * Provides per-origin builders (host RPC, host stream, renderer,
 * extension, and a generic "test") so test code can construct an
 * authenticated context without importing host-only transport types.
 *
 * These fixtures intentionally do NOT depend on core auth controllers or
 * host WS transport - the shared-core context surface must remain
 * platform-neutral, and tests for that surface must reflect that.
 */
import type { AuthenticatedUser } from "@traycer/protocol/auth";
import {
  createRequestContext,
  identityFromAuthenticatedUser,
  type AuthenticatedIdentity,
  type RequestContext,
  type RequestContextOrigin,
} from "@traycer/protocol/auth/request-context";
import { createAuthenticatedUserFixture } from "./authenticated-user";

export interface RequestContextFixtureOverrides {
  readonly user: AuthenticatedUser | undefined;
  readonly userOverrides: Partial<AuthenticatedUser> | undefined;
  readonly identity: AuthenticatedIdentity | undefined;
  readonly bearerToken: string | undefined;
  readonly origin: RequestContextOrigin | undefined;
  readonly connectionId: string | undefined;
  readonly operationId: string | undefined;
  readonly externalAbortSignal: AbortSignal | undefined;
  /**
   * The fixture's cloud verdict. Defaults to `true`, which is what the
   * overwhelming majority of suites mean by "a signed-in context" - pass
   * `false` to build the `unverified` shape.
   *
   * There are exactly those two states to ask for; there is no third
   * "verdict-absent" context to build. `createRequestContext` collapses
   * `undefined` into `true` at construction and `RequestContext` exposes a
   * plain `boolean`, so a peer that does not speak verdicts IS an authorized
   * context - the distinction lives at the construction SITE, not in the
   * object. `| undefined` here is only this interface's uniform shape: it is
   * consumed as `Partial<>`, so an omitted key and an explicit `undefined`
   * are the same request for the default, exactly as for the `bearerToken`
   * and `origin` fields above.
   */
  readonly cloudAuthorized: boolean | undefined;
}

const DEFAULT_BEARER = "test-bearer-token";

function resolveIdentity(
  overrides: Partial<RequestContextFixtureOverrides>,
): AuthenticatedIdentity {
  if (overrides.identity !== undefined) {
    return overrides.identity;
  }
  if (overrides.user !== undefined) {
    return identityFromAuthenticatedUser(overrides.user);
  }
  return identityFromAuthenticatedUser(
    createAuthenticatedUserFixture(overrides.userOverrides),
  );
}

/**
 * Generic builder that allows callers to override every input. Defaults
 * to a `"test"` origin context with a deterministic bearer.
 */
export function createRequestContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  const identity = resolveIdentity(overrides);
  return createRequestContext({
    identity,
    bearerToken: overrides.bearerToken ?? DEFAULT_BEARER,
    origin: overrides.origin ?? "test",
    connectionId: overrides.connectionId,
    operationId: overrides.operationId,
    externalAbortSignal: overrides.externalAbortSignal,
    cloudAuthorized: overrides.cloudAuthorized ?? true,
  });
}

/**
 * Host unary RPC fixture. Every host WS open frame mints exactly
 * one of these per accepted connection at the boundary.
 */
export function createHostRpcContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "host-rpc",
    connectionId: overrides.connectionId ?? "test-rpc-connection",
  });
}

/**
 * Host stream fixture. The dispatcher mints `connectionId` per WS
 * accept; tests should mirror that by supplying one (or accepting the
 * default).
 */
export function createHostStreamContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "host-stream",
    connectionId: overrides.connectionId ?? "test-stream-connection",
  });
}

/**
 * Renderer fixture. Renderer/extension flows are single-user and have no
 * connection id; the context is built at the renderer auth boundary.
 */
export function createRendererContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "renderer",
    connectionId: undefined,
  });
}

/**
 * Extension fixture. Same single-user shape as the renderer; the origin
 * tag exists so guard tests can distinguish them when needed.
 */
export function createExtensionContextFixture(
  overrides: Partial<RequestContextFixtureOverrides>,
): RequestContext {
  return createRequestContextFixture({
    ...overrides,
    origin: "extension",
    connectionId: undefined,
  });
}
