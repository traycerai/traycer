import { z } from "zod";

/**
 * Client-side mirror of the Remote Host Support status contract.
 *
 * ⚠️ CROSS-REPO MIRROR — keep in sync with the internal monorepo:
 *   - `@traycerai/common/types/host` (`HostStatusDTO`, `HostKind`,
 *     `HostUpdateState`, presence/viewer/cloud enums) — the T1 contract, and
 *   - `authn-v3/src/utils/hosts/host-status-dto.ts` (`HostListItem`) +
 *     `authn-v3/src/utils/hosts/host-presence.ts` (`HostPresenceHealth`) — the
 *     T5 `GET /api/v3/hosts` response envelope.
 *
 * The open-source `traycer/` submodule does NOT depend on `@traycerai/common`
 * (zero references in the repo), so the DTO cannot be imported across the repo
 * boundary. `@traycer/protocol` is the shared workspace every client already
 * consumes, so the contract is mirrored here. Field names match the JSON wire
 * shape verbatim (camelCase, exactly what authn-v3 serializes). When the
 * server contract changes, update this file to match — the Zod schemas below
 * fail closed on drift (an unknown/removed field surfaces as a parse error the
 * fetcher classifies as a transport failure, never a silent mis-render).
 *
 * Populated fields in S1 (registry + presence only):
 *   `presenceLease`, `clientCloud`, `busy`, `updateState`, `appVersion`,
 *   `lastSeenAt`. The relay-derived fields (`hostRelayAttached`,
 *   `viewerReachability`) carry their shape-only defaults until S2.
 */

// -----------------------------------------------------------------------------
// Enums (mirror `@traycerai/common/types/host`)
// -----------------------------------------------------------------------------

/** Host classification. Mirrors the `HostKind` common type / Prisma enum. */
export type HostRegistryKind = "personal" | "sandbox";

/** Freshness of the presence lease as judged by coordination. */
export type HostPresenceLeaseState = "fresh" | "stale" | "expired";

/** This client's own probe result at tab-open / on-demand (S2). */
export type HostViewerReachability = "ok" | "failing" | "unknown";

/** Whether this client is online at all. */
export type HostClientCloudState = "ok" | "down";

/** Update lifecycle surfaced per host (Architecture §7 & §13). */
export type HostUpdateState =
  | "current"
  | "available"
  | "pending"
  | "updating"
  | "failed"
  | "required";

/**
 * Per-host update policy (Architecture §13, T16). `manual` (default) means
 * updates are the user's explicit choice; `auto` is an explicit per-host
 * opt-in. Mirrors `@traycerai/common/types/host`'s `HostUpdatePolicy` /
 * the `HostUpdatePolicy` Prisma enum verbatim.
 */
export type HostUpdatePolicy = "manual" | "auto";

// -----------------------------------------------------------------------------
// Status DTO — the single render source (Architecture §7)
// -----------------------------------------------------------------------------

export type HostStatusDTO = {
  /** Lease freshness — hearsay about the heartbeat leg, not the data path. */
  presenceLease: HostPresenceLeaseState;
  /** Is the HOST's relay leg up? From the relay via CS (S2). */
  hostRelayAttached: boolean;
  /** This client's probe of its own path to the host (S2). */
  viewerReachability: HostViewerReachability;
  /** Is this client online at all. */
  clientCloud: HostClientCloudState;
  /** Active agent turns / watched PTYs / queued work. */
  busy: boolean;
  /**
   * Count of sessions currently blocking an update drain (Architecture §13,
   * T16) — populated (`> 0`) whenever `updateState === "pending"` and the
   * host is waiting on open sessions before it can swap; `0` otherwise. Backs
   * the "Waiting for N sessions" copy and the "Apply now — ends N sessions"
   * drain-force affordance.
   */
  busySessionCount: number;
  /** Update lifecycle for the host. */
  updateState: HostUpdateState;
  /** App version the host last reported (null until first heartbeat). */
  appVersion: string | null;
  /** ISO-8601 last-seen timestamp from Postgres (null until first seen). */
  lastSeenAt: string | null;
};

// -----------------------------------------------------------------------------
// `GET /api/v3/hosts` response envelope (mirror authn-v3 T5)
// -----------------------------------------------------------------------------

/** A single registry row: durable identity wrapping the status DTO. */
export type HostListItem = {
  hostId: string;
  displayName: string | null;
  platform: string | null;
  kind: HostRegistryKind;
  /** Host static key for the E2E Noise-NK handshake (consumed in S2). */
  publicKey: string;
  createdAt: string;
  status: HostStatusDTO;
  /**
   * This host's configured update policy (Architecture §13, T16): `manual`
   * (default) surfaces "Update now" as an explicit action; `auto` means the
   * reconciler applies an approved `desiredVersion` without a per-update
   * click. Drives the My Hosts auto-update toggle.
   */
  updatePolicy: HostUpdatePolicy;
};

/**
 * CS self-health of the presence-ingestion pipeline (R4-C3). `degraded` means
 * coordination cannot currently read presence, so the client MUST render an
 * `expired` lease as "status unknown — presence degraded", never a false
 * "Offline — last seen …" (Architecture §7).
 */
export type HostPresenceHealth = {
  status: "healthy" | "degraded";
  /** Machine-readable cause when degraded; null when healthy. */
  reason: string | null;
};

export type HostListResponse = {
  hosts: HostListItem[];
  presenceHealth: HostPresenceHealth;
};

// -----------------------------------------------------------------------------
// Zod schemas — fail-closed parsing of the untrusted network response
// -----------------------------------------------------------------------------

export const hostPresenceLeaseStateSchema = z.enum([
  "fresh",
  "stale",
  "expired",
]);

export const hostViewerReachabilitySchema = z.enum([
  "ok",
  "failing",
  "unknown",
]);

export const hostClientCloudStateSchema = z.enum(["ok", "down"]);

export const hostUpdateStateSchema = z.enum([
  "current",
  "available",
  "pending",
  "updating",
  "failed",
  "required",
]);

export const hostRegistryKindSchema = z.enum(["personal", "sandbox"]);

export const hostUpdatePolicySchema = z.enum(["manual", "auto"]);

export const hostStatusDtoSchema: z.ZodType<HostStatusDTO> = z.object({
  presenceLease: hostPresenceLeaseStateSchema,
  hostRelayAttached: z.boolean(),
  viewerReachability: hostViewerReachabilitySchema,
  clientCloud: hostClientCloudStateSchema,
  busy: z.boolean(),
  busySessionCount: z.number(),
  updateState: hostUpdateStateSchema,
  appVersion: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

export const hostListItemSchema: z.ZodType<HostListItem> = z.object({
  hostId: z.string(),
  displayName: z.string().nullable(),
  platform: z.string().nullable(),
  kind: hostRegistryKindSchema,
  publicKey: z.string(),
  createdAt: z.string(),
  status: hostStatusDtoSchema,
  updatePolicy: hostUpdatePolicySchema,
});

export const hostPresenceHealthSchema: z.ZodType<HostPresenceHealth> = z.object({
  status: z.enum(["healthy", "degraded"]),
  reason: z.string().nullable(),
});

export const hostListResponseSchema: z.ZodType<HostListResponse> = z.object({
  hosts: z.array(hostListItemSchema),
  presenceHealth: hostPresenceHealthSchema,
});

// -----------------------------------------------------------------------------
// `PATCH /api/v3/hosts/:hostId` response — "Update now" / auto-policy toggle /
// "Apply now — ends N sessions" (Architecture §13, T16; mirror authn-v3's
// `PATCH /api/v3/hosts/:hostId` route)
// -----------------------------------------------------------------------------

/**
 * Response body of `PATCH /api/v3/hosts/:hostId`. Deliberately snake_case —
 * unlike the rest of this file's camelCase DTOs, this mirrors the wire shape
 * verbatim (exactly what authn-v3 serializes for this route).
 */
export type HostVersionPolicyResponse = {
  host_id: string;
  update_policy: HostUpdatePolicy;
  desired_version: string | null;
};

export const hostVersionPolicyResponseSchema: z.ZodType<HostVersionPolicyResponse> =
  z.object({
    host_id: z.string(),
    update_policy: hostUpdatePolicySchema,
    desired_version: z.string().nullable(),
  });
