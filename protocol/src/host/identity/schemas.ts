import { z } from "zod";

/** RPC payloads for the host's display name - the host-mastered rename surface. */

/** Transport-safety bound only - see the module doc for who owns the real rule. */
export const HOST_NAME_MAX_TRANSPORT_LENGTH = 1024;

const emptyRequestSchema = z.object({});

/**
 * What every identity call answers with: - `systemName` - the machine's own name (`os.hostname()`), never empty. - `customName` - the normalized user override, or `null` when unset. - `effectiveName`- what clients should.
 */
export const hostIdentitySchema = z.object({
  systemName: z.string().min(1),
  customName: z.string().min(1).nullable(),
  effectiveName: z.string().min(1),
});
export type HostIdentity = z.infer<typeof hostIdentitySchema>;

export const hostIdentityGetRequestSchema = emptyRequestSchema;
export type HostIdentityGetRequest = z.infer<
  typeof hostIdentityGetRequestSchema
>;

export const hostIdentityGetResponseSchema = hostIdentitySchema;
export type HostIdentityGetResponse = z.infer<
  typeof hostIdentityGetResponseSchema
>;

export const hostIdentitySetRequestSchema = z.object({
  customName: z.string().max(HOST_NAME_MAX_TRANSPORT_LENGTH).nullable(),
});
export type HostIdentitySetRequest = z.infer<
  typeof hostIdentitySetRequestSchema
>;

/** The post-write identity, so a caller never has to re-`get` to render it. */
export const hostIdentitySetResponseSchema = hostIdentitySchema;
export type HostIdentitySetResponse = z.infer<
  typeof hostIdentitySetResponseSchema
>;
