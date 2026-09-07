import { z } from "zod";

/**
 * `host.status@1.2` - Client-side mirror of the Remote Host Support status contract.
 * A client with neither has no live source and must render no drain state at all - not a stale one, and not a zero.
 */


/** Host classification. Mirrors the `HostKind` common type / Prisma enum. */
export type HostRegistryKind = "personal" | "sandbox";

/**
 * Whether this host can be reached, as the cloud sees it.
 * Never render this as Offline: blind is not the same as absent, and the durable `lastSeenAt` is the only honest thing left to show.
 */
export type HostConnectivity =
  | "connectable"
  | "offline"
  | "unknown"
  | "local-only";

/**
 * TOMBSTONED (redesign P3.4).
 * The probe was never built: the server has always sent `"unknown"` and, as of P3.4, no client reads the field at all.
 */
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

export type HostUpdatePolicy = "manual" | "auto";


export type HostStatusDTO = {
  /** The single liveness word, from the relay lease. */
  connectivity: HostConnectivity;
  /** Tombstoned; parsed and ignored. See {@link HostViewerReachability}. */
  viewerReachability: HostViewerReachability;
  /** Is this client online at all. */
  clientCloud: HostClientCloudState;
  /** Update lifecycle for the host. */
  updateState: HostUpdateState;
  /** App version the host last reported (null until first check-in). */
  appVersion: string | null;
  /** ISO-8601 last-seen timestamp from Postgres (null until first seen). */
  lastSeenAt: string | null;
};


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
  updatePolicy: HostUpdatePolicy;
};

/** The `GET /api/v3/hosts` envelope. */
export type HostListResponse = {
  hosts: HostListItem[];
};

// Zod schemas - fail-closed parsing of the untrusted network response

export const hostConnectivitySchema = z.enum([
  "connectable",
  "offline",
  "unknown",
  "local-only",
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

// `.strict()` on every level (S5 / fix #5): a non-strict `z.object` silently STRIPS a field the server adds, so a contract addition would render with a piece quietly missing instead of failing loud.
export const hostStatusDtoSchema: z.ZodType<HostStatusDTO> = z
  .object({
    connectivity: hostConnectivitySchema,
    viewerReachability: hostViewerReachabilitySchema,
    clientCloud: hostClientCloudStateSchema,
    updateState: hostUpdateStateSchema,
    appVersion: z.string().nullable(),
    lastSeenAt: z.string().nullable(),
  })
  .strict();

export const hostListItemSchema: z.ZodType<HostListItem> = z
  .object({
    hostId: z.string(),
    displayName: z.string().nullable(),
    platform: z.string().nullable(),
    kind: hostRegistryKindSchema,
    publicKey: z.string(),
    createdAt: z.string(),
    status: hostStatusDtoSchema,
    updatePolicy: hostUpdatePolicySchema,
  })
  .strict();

export const hostListResponseSchema: z.ZodType<HostListResponse> = z
  .object({
    hosts: z.array(hostListItemSchema),
  })
  .strict();


/** Response body of `PATCH /api/v3/hosts/:hostId`. */
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
