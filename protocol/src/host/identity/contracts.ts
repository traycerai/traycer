import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  hostIdentityGetRequestSchema,
  hostIdentityGetResponseSchema,
  hostIdentitySetRequestSchema,
  hostIdentitySetResponseSchema,
} from "./schemas";

/**
 * Reads the connected host's own display name. The host is the master copy —
 * the registry's `displayName` only follows it via the presence heartbeat — so
 * a reachable host answers this rather than the client reading cloud state.
 */
export const hostIdentityGetV10 = defineRpcContract({
  method: "host.identity.get",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostIdentityGetRequestSchema,
  responseSchema: hostIdentityGetResponseSchema,
});

/**
 * Writes the host's custom name (or clears it with `null`). Rejects a name the
 * host cannot store verbatim instead of truncating it, and returns the identity
 * the host actually persisted.
 */
export const hostIdentitySetV10 = defineRpcContract({
  method: "host.identity.set",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: hostIdentitySetRequestSchema,
  responseSchema: hostIdentitySetResponseSchema,
});
