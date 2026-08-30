import { z } from "zod";

/**
 * Client-side mirror of the Remote Host Support status contract.
 *
 * ⚠️ CROSS-REPO MIRROR — keep in sync with the internal monorepo:
 *   - `@traycerai/common/types/host` (`HostStatusDTO`, `HostKind`,
 *     `HostUpdateState`, presence/viewer/cloud enums) — the T1 contract, and
 *   - `authn-v3/src/utils/hosts/host-status-dto.ts` (`HostListItem`) — the
 *     `GET /api/v3/hosts` response envelope.
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
 * Liveness is RELAY-ATTACHMENT, not a heartbeat. The 20s host→authn beat and
 * the presence lease it fed are gone; the relay pushes attach/detach and authn
 * keeps a short-TTL lease, which it collapses into the single {@link
 * HostConnectivity} enum below. That replaced `presenceLease` (a tri-state
 * about the beat leg) and `hostRelayAttached` (a second, separately-derived
 * claim about the same leg — the pair is what produced the "Up, re-establishing
 * its tunnel" and "Not reporting — likely reachable" states, both of which
 * described a disagreement between two signals rather than anything about the
 * host).
 *
 * `busy` / `busySessionCount` went with them, for a different reason: they
 * describe a *right now* that a lease refreshed on the order of minutes cannot
 * carry. Both already exist on the live host↔GUI connection
 * (`host.status@1.2`), and the notification room's
 * {@link HOST_RUNTIME_STATUS_AWARENESS_FIELD} carries them for surfaces that
 * hold a room rather than a session. A client with neither has no live source
 * and must render no drain state at all — not a stale one, and not a zero.
 *
 * `updateState` / `appVersion` / `lastSeenAt` STAY: they are Postgres-derived,
 * cost no liveness read, and are precisely what an OFFLINE host's update UI
 * needs to stay useful.
 *
 * This shape changed in one coordinated cut with authn — no version marker, no
 * dual-parse. That is only sound because nothing released parses it; treat any
 * FUTURE change as breaking (`.strict()` at every level, and GUIs have no
 * force-update lever).
 */

// -----------------------------------------------------------------------------
// Enums (mirror `@traycerai/common/types/host`)
// -----------------------------------------------------------------------------

/** Host classification. Mirrors the `HostKind` common type / Prisma enum. */
export type HostRegistryKind = "personal" | "sandbox";

/**
 * Whether this host can be reached, as the cloud sees it. The ONE liveness
 * word — there is no second signal to reconcile it against.
 *
 *  - `connectable` — the relay holds a live attachment for the host's own leg.
 *    This is what "Online" means now.
 *  - `offline`     — no attachment. Includes a host that is *running* but whose
 *    relay egress is blocked (the ws-proxy population): the client cannot get
 *    to it, so saying anything warmer than Offline would be a promise we can't
 *    keep. Support reading: "Offline + host process up ⇒ relay egress blocked".
 *  - `unknown`     — the liveness store could not be read. Never render this as
 *    Offline: blind is not the same as absent, and the durable `lastSeenAt` is
 *    the only honest thing left to show.
 *
 * The server's current values are PURE LIVENESS — one fact about one host —
 * and deliberately say nothing about the account's plan. `local-only` remains
 * accepted temporarily as a rollout-compatibility input from older servers;
 * it meant "the owner's plan has no remote hosts". That legacy value
 * collapsed two independent facts (is this host alive? does this account's plan
 * include remote hosts?) into one word, with the plan word outranking liveness:
 * on a free plan every remote host read `local-only` whether it was alive,
 * asleep, or gone for good, so the client could not tell those apart and the
 * host-death gates could never fire. The plan is an ACCOUNT fact the client
 * already owns from sign-in, and it combines the two axes at projection time
 * (`hostListItemToDirectoryEntry` stamps `planAllowsRemote`;
 * `hostUnavailability` returns `plan-restricted` for a plan-gated host that is
 * alive or unreadable, and a plain `offline` for a plan-gated host that is
 * genuinely dead).
 *
 * ⚠️ ROLLOUT: ship this tolerant client before authn-v3 stops emitting
 * `local-only`. Remove the compatibility value only after that server change
 * is verified live and the supported client floor has advanced.
 *
 * Detach latency is asymmetric and the UI copy should not over-promise: a clean
 * teardown is pushed in seconds, while a dirty death (lid close, cable pull)
 * waits out the lease TTL — on the order of 15 minutes.
 */
export type HostConnectivity =
  | "connectable"
  | "offline"
  | "unknown"
  | "local-only";

/**
 * TOMBSTONED (redesign P3.4). Was "this client's own probe result at
 * tab-open / on-demand (S2)". The probe was never built: the server has
 * always sent `"unknown"` and, as of P3.4, no client reads the field at all.
 *
 * It stays on the wire because it CANNOT be removed unilaterally in either
 * direction - `hostStatusDtoSchema` is `.strict()` and this key is required,
 * so a server that stopped sending it would fail every released client's
 * parse of `GET /api/v3/hosts`, and a client that dropped it from the schema
 * would reject the payloads the server still sends. Dropping it is a
 * two-release sequence: (1) this release stops reading it, (2) once the
 * support floor is past a client that tolerates its absence, the server stops
 * emitting and the key leaves the schema. Do not skip step 1's soak.
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
 * The `GET /api/v3/hosts` envelope. Just the rows.
 *
 * It used to carry a `presenceHealth` flag — the server's self-report that its
 * liveness-read pipeline was degraded — which the client turned into "status
 * unknown" instead of a false "Offline". That rule is intact and load-bearing;
 * it simply moved INTO the row, as `connectivity: "unknown"`. Per-host is the
 * better carrier: a partial read (some hosts resolved, the rest not) has an
 * honest answer under the per-host form and none at all under one envelope
 * flag, which had to be all-or-nothing and so was wrong in one direction or
 * the other whenever the read was partial.
 */
export type HostListResponse = {
  hosts: HostListItem[];
};

// -----------------------------------------------------------------------------
// Zod schemas — fail-closed parsing of the untrusted network response
// -----------------------------------------------------------------------------

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

// `.strict()` on every level (S5 / fix #5): a non-strict `z.object` silently
// STRIPS a field the server adds, so a contract addition would render with a
// piece quietly missing instead of failing loud. `.strict()` is not deep, so
// each nested object below opts in individually — the negative fixture test
// in `__tests__/host-status.test.ts` proves this actually rejects rather than
// strips at every level, not just the top one.
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
