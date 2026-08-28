import { z } from "zod";

/**
 * RPC payloads for the host's display name — the host-mastered rename surface.
 *
 * The host owns `<host slot root>/host-name.json` (`{ customName }`) and is the
 * only authority on what a name normalizes to. These schemas therefore carry a
 * generous transport-safety bound ONLY; the real rule (trim, collapse internal
 * whitespace, reject anything longer than the host's maximum rather than
 * truncating it) is enforced by the host resolver, which fails the call with an
 * error instead of silently storing a different name than the caller asked for.
 *
 * Keeping the length rule out of the wire schema is deliberate: a raw cap here
 * would reject `"  a<80 spaces>b  "` that normalizes well inside the limit, so
 * client and host would disagree about which names are legal.
 */

/** Transport-safety bound only — see the module doc for who owns the real rule. */
export const HOST_NAME_MAX_TRANSPORT_LENGTH = 1024;

const emptyRequestSchema = z.object({});

/**
 * What every identity call answers with:
 *  - `systemName`   — the machine's own name (`os.hostname()`), never empty.
 *  - `customName`   — the normalized user override, or `null` when unset.
 *  - `effectiveName`— what clients should display, and the ONLY field they
 *    should display. It is `customName` when the user set one, otherwise the
 *    host's registration label.
 *
 * `effectiveName` is deliberately not `customName ?? systemName`. On an
 * ordinary machine the label IS `os.hostname()` and the two are identical; on a
 * provisioned host started with `TRAYCER_HOST_LABEL` they differ, and the label
 * is the name the cloud registry already shows. The registry's `displayName`
 * follows this exact value each time the host republishes it on its periodic
 * credential refresh (not the deleted presence heartbeat) - so a client that
 * reads a reachable host over RPC and one that falls back to the registry for
 * an unreachable host CONVERGE on the same name once that republish lands.
 * Between a rename and the next refresh the RPC answer leads the registry:
 * `host.identity.set` writes only the host-mastered store, so a connected
 * client sees the new name immediately while the registry still shows the
 * previous one. Single source of truth with bounded registry lag - not
 * instant agreement - is the contract of moving the name onto the host.
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

/**
 * `null` clears the override, falling `effectiveName` back to the host's
 * registration label (which is the system hostname only on a host that was not
 * started with one) — see {@link hostIdentitySchema}.
 */
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
