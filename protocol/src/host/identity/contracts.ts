import { defineRpcContract } from "@traycer/protocol/framework/index";
import {
  hostIdentityGetRequestSchema,
  hostIdentityGetResponseSchema,
  hostIdentitySetRequestSchema,
  hostIdentitySetResponseSchema,
} from "./schemas";

/**
 * Reads the connected host's own display name. The host is the master copy: the
 * registry's `displayName` only follows it when the host republishes the name
 * on its periodic credential refresh (the host-leg re-auth cadence, ~10-15 min;
 * the 20s presence beat that used to carry a rename is deleted). The cloud row
 * can therefore lag a rename made on the box by minutes - orders of magnitude
 * longer than the old beat - so a reachable host answers this rather than the
 * client reading the possibly-stale cloud state.
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
