import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  HOST_SANDBOX_STATES,
  type HostSandboxState,
} from "@traycer/protocol/host/host-status";

/**
 * Client-side mirror of traycer-server's sandbox control plane
 * (`/api/sandboxes`), the routes a client calls with the user bearer to list,
 * price, create, destroy and wake on-demand sandbox hosts.
 *
 * ⚠️ CROSS-REPO MIRROR of `traycer-server/src/routes/api/sandboxes/index.ts`
 * and `services/sandboxes/{sandbox-view,catalogue}.ts`. The OSS clients cannot
 * import the server's types, so the wire shape is mirrored here, where the
 * host's agent tools can read it too.
 *
 * Unlike `host-status.ts`, these objects are NOT `.strict()`. That file guards
 * a response every RELEASED client parses, where a silently stripped field is
 * a mis-render; these routes are new, read only by builds that know them, and
 * a tolerant reader lets the server add a field (a cost figure, a secrets
 * summary) without a lockstep client release. The closed vocabularies (state,
 * OS) still fail a parse on a value this build does not know.
 *
 * Money is in millicredits (`Mc`), the credit service's unit.
 */

export type SandboxOs = "linux" | "windows";

export const sandboxOsSchema = lazySchema(() => z.enum(["linux", "windows"]));

/** `agent` is a sandbox host; `automation` is the per-user Automations pod. */
export type SandboxKind = "agent" | "automation";

export const sandboxKindSchema = lazySchema(() =>
  z.enum(["agent", "automation"]),
);

/**
 * Price per hour of one sandbox in each billed state, in millicredits: a
 * created sandbox's `priceMcPerHour`, and a catalogue region's "from" price.
 */
export interface SandboxHourlyPrice {
  readonly awakeMc: number;
  readonly suspendedMc: number;
  readonly stoppedMc: number;
}

export const sandboxHourlyPriceSchema: z.ZodType<SandboxHourlyPrice> =
  lazySchema(() =>
    z.object({
      awakeMc: z.number().nonnegative(),
      suspendedMc: z.number().nonnegative(),
      stoppedMc: z.number().nonnegative(),
    }),
  );

/**
 * The phases a sandbox host reports in its heartbeat while it wakes, in the
 * order it passes through them. `proxy-reachable` and `ready` both mean the
 * egress canary answered: brokered traffic flows. `proxy-reachable` is the
 * heartbeat the control plane activates the wake on, and the host moves to
 * `ready` on that heartbeat's answer.
 *
 * The wire value is a string, not this list: a degraded host reports
 * `degraded(<hop>)` with the failed hop named, and a phase newer than this
 * build must not fail the sandbox list. Read it with
 * {@link parseSandboxHeartbeatPhase}.
 */
export const SANDBOX_HEARTBEAT_PHASES = [
  "enrolling",
  "proving",
  "attaching",
  "proxy-reachable",
  "ready",
] as const;

export type SandboxHeartbeatPhaseName =
  (typeof SANDBOX_HEARTBEAT_PHASES)[number];

export type SandboxHeartbeatPhase =
  | { readonly kind: SandboxHeartbeatPhaseName }
  | { readonly kind: "degraded"; readonly hop: string }
  /** A phase this build does not know; shown as nothing, never as ready. */
  | { readonly kind: "unknown"; readonly raw: string };

const DEGRADED_PHASE_PATTERN = /^degraded\((.*)\)$/;

export function parseSandboxHeartbeatPhase(
  phase: string,
): SandboxHeartbeatPhase {
  const named = SANDBOX_HEARTBEAT_PHASES.find((name) => name === phase);
  if (named !== undefined) return { kind: named };
  const degraded = DEGRADED_PHASE_PATTERN.exec(phase);
  if (degraded !== null) return { kind: "degraded", hop: degraded[1] ?? "" };
  return { kind: "unknown", raw: phase };
}

/**
 * Where one brokered route of a sandbox stands, as its host last reported it:
 *
 *  - `pending`: the route's endpoint is bound and nothing has used it yet.
 *  - `ready`: a first connection went through to its worker.
 *  - `unavailable`: the route cannot serve; `code` says why
 *    (`endpoint_unavailable`, `leaf_unavailable`, `connector_offline`, ...).
 */
export type SandboxRouteState = "pending" | "ready" | "unavailable";

export const sandboxRouteStateSchema = lazySchema(() =>
  z.enum(["pending", "ready", "unavailable"]),
);

export interface SandboxRouteReadiness {
  /** The route id; joins the sandbox's grants summary and its egress events. */
  readonly route: string;
  readonly state: SandboxRouteState;
  /** The refusal code on an `unavailable` route, else `null`. */
  readonly code: string | null;
}

export const sandboxRouteReadinessSchema: z.ZodType<SandboxRouteReadiness> =
  lazySchema(() =>
    z.object({
      route: z.string().min(1),
      state: sandboxRouteStateSchema,
      code: z.string().nullable().default(null),
    }),
  );

/**
 * One sandbox as `GET /api/sandboxes`, `GET /api/sandboxes/:id` and the
 * create and destroy answers carry it (the server's `SandboxView`). The list
 * excludes destroyed rows.
 */
export interface SandboxSummary {
  /** The sandbox id: the path segment of every `/api/sandboxes/:id` verb. */
  readonly id: string;
  /** The host id the sandbox enrolled under; joins the host list row. */
  readonly hostId: string;
  readonly kind: SandboxKind;
  /** `tensorlake`, `daytona`, `gke-automation`; read as text, never branched on. */
  readonly provider: string;
  readonly region: string;
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly displayName: string;
  readonly state: HostSandboxState;
  readonly frozen: boolean;
  /** The vendor's or the lifecycle's code on a `failed` row, else `null`. */
  readonly failureCode: string | null;
  /** `null` = the default idle period (30 minutes). */
  readonly idleMinutes: number | null;
  /** Created by an agent for one task; offered in no picker. */
  readonly burst: boolean;
  readonly createdByHostId: string | null;
  readonly createdByAgentId: string | null;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly lastTransitionAt: number;
  readonly lastActivityAt: number | null;
  readonly destroyedAt: number | null;
  /**
   * When the row was frozen for lack of credits (epoch milliseconds); `null`
   * whenever `frozen` is false. A frozen row is destroyed
   * {@link SANDBOX_FROZEN_RETENTION_DAYS} days after it.
   */
  readonly frozenAt: number | null;
  /**
   * The guest's configuration step as its host last reported it in the
   * heartbeat; `null` before any report.
   */
  readonly guestConfigured: boolean | null;
  /** Why it failed, as the guest reported it, when `guestConfigured` is false. */
  readonly guestConfigFailureReason: string | null;
  /**
   * The wake phase its host last reported in the heartbeat (see
   * {@link SANDBOX_HEARTBEAT_PHASES}); `null` before any report and from a
   * server that predates the secrets broker.
   *
   * It rides this tolerant row and NOT the host registry row: that row is
   * `.strict()` on `GET /api/v3/hosts` and on `host.hostInventory.subscribe`,
   * so a key added there fails the whole host list of every build that
   * already asks for sandbox rows.
   */
  readonly phase: string | null;
  /**
   * Each brokered route's readiness, as its host last reported it; `null`
   * before any report and from a server that predates the secrets broker.
   */
  readonly routes: readonly SandboxRouteReadiness[] | null;
  /** `null` when this server has no price configured for the provider. */
  readonly priceMcPerHour: SandboxHourlyPrice | null;
  /**
   * The environment the sandbox belongs to; `null` from a server that
   * predates environments, which reads as the person's Personal one.
   */
  readonly environmentId: string | null;
  /**
   * The member who created a team sandbox; `null` on a personal sandbox, a
   * pod, and from a server that predates the field.
   */
  readonly createdBy: SandboxMember | null;
  /**
   * The member paying for the current wake of a team sandbox; `null` while
   * it is not awake, on a personal sandbox (its owner pays), and from a server
   * before it.
   */
  readonly wakePayer: SandboxMember | null;
  /**
   * The member who kept a sandbox an agent created, turning it into one that
   * waits for its owner (`burst` false); `null` on a row nobody kept and from
   * a server before keep.
   */
  readonly keptBy: SandboxMember | null;
  /**
   * When the row last came to rest (suspended or stopped), epoch
   * milliseconds: the start of the resting-destroy clock. Cleared on wake,
   * kept through a failed wake, restarted by a thaw and by a changed resting
   * period. `null` while not resting and from a server before the clock.
   */
  readonly restingSince: number | null;
  /**
   * Minutes the row may rest before the control plane destroys it; `null`
   * means never, and is also what a server before the clock sends.
   */
  readonly destroyAfterRestingMinutes: number | null;
  /**
   * When the resting clock destroys the row (epoch milliseconds), as the
   * server computes it from `restingSince` and the period; `null` while not
   * resting, on a row that rests forever, and from a server before the clock.
   */
  readonly destroyAt: number | null;
  /**
   * The task an agent created the sandbox for; `null` on a row created from
   * the GUI and from a server before the field.
   */
  readonly createdByTaskId: string | null;
}

/**
 * A team member as a team sandbox's card names them. `userId` lets the card
 * say "you"; `displayName` is `null` when the member has none to show.
 */
export interface SandboxMember {
  readonly userId: string;
  readonly displayName: string | null;
}

export const sandboxMemberSchema: z.ZodType<SandboxMember> = lazySchema(() =>
  z.object({
    userId: z.string().min(1),
    displayName: z.string().nullable(),
  }),
);

/** Days a frozen sandbox is kept before the control plane destroys it. */
export const SANDBOX_FROZEN_RETENTION_DAYS = 30;

export const sandboxSummarySchema: z.ZodType<SandboxSummary> = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    hostId: z.string().min(1),
    kind: sandboxKindSchema,
    provider: z.string(),
    region: z.string(),
    os: sandboxOsSchema,
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    diskMb: z.number().int().nonnegative(),
    displayName: z.string(),
    state: z.enum(HOST_SANDBOX_STATES),
    frozen: z.boolean(),
    failureCode: z.string().nullable(),
    idleMinutes: z.number().int().positive().nullable(),
    burst: z.boolean(),
    createdByHostId: z.string().nullable(),
    createdByAgentId: z.string().nullable(),
    createdAt: z.number(),
    lastTransitionAt: z.number(),
    lastActivityAt: z.number().nullable(),
    destroyedAt: z.number().nullable(),
    // Read as `null` when absent: a server from before these three fields
    // still parses, and the card shows nothing it cannot know.
    frozenAt: z.number().nullable().default(null),
    guestConfigured: z.boolean().nullable().default(null),
    guestConfigFailureReason: z.string().nullable().default(null),
    // The same tolerance for the two secrets-broker fields. `routes` also
    // reads as `null` when it does not parse (a route state newer than this
    // build): one unreadable route must not fail the row, and with it the
    // whole sandbox list.
    phase: z.string().nullable().default(null),
    routes: z
      .array(sandboxRouteReadinessSchema)
      .nullable()
      .default(null)
      .catch(null),
    priceMcPerHour: sandboxHourlyPriceSchema.nullable(),
    environmentId: z.string().min(1).nullable().default(null),
    // Read as `null` when absent, so a server that predates them parses.
    createdBy: sandboxMemberSchema.nullable().default(null),
    wakePayer: sandboxMemberSchema.nullable().default(null),
    keptBy: sandboxMemberSchema.nullable().default(null),
    restingSince: z.number().nullable().default(null),
    destroyAfterRestingMinutes: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .default(null),
    destroyAt: z.number().nullable().default(null),
    createdByTaskId: z.string().min(1).nullable().default(null),
  }),
);

export interface SandboxListResponse {
  readonly sandboxes: readonly SandboxSummary[];
}

export const sandboxListResponseSchema: z.ZodType<SandboxListResponse> =
  lazySchema(() =>
    z.object({
      sandboxes: z.array(sandboxSummarySchema),
    }),
  );

/**
 * One Automations pod as `GET /api/sandboxes/automation` lists it: its row,
 * its slot, the shells its host last reported (0 once that report is stale)
 * and the shells it can still take.
 */
export interface SandboxPod {
  readonly sandbox: SandboxSummary;
  readonly ordinal: number;
  readonly liveShells: number;
  readonly headroom: number;
}

export const sandboxPodSchema: z.ZodType<SandboxPod> = lazySchema(() =>
  z.object({
    sandbox: sandboxSummarySchema,
    ordinal: z.number().int().nonnegative(),
    liveShells: z.number().int().nonnegative(),
    headroom: z.number().int().nonnegative(),
  }),
);

/**
 * `GET /api/sandboxes/automation`: the environment's Automations host.
 * `available` is false on a deployment with no Automations cluster;
 * `sandbox` is `null` until the row first exists (the first open creates
 * it). `pods` lists every live pod (a team's may hold several); `[]` from a
 * server before the pod list.
 */
export interface SandboxAutomationResponse {
  readonly available: boolean;
  readonly sandbox: SandboxSummary | null;
  readonly pods: readonly SandboxPod[];
}

export const sandboxAutomationResponseSchema: z.ZodType<SandboxAutomationResponse> =
  lazySchema(() =>
    z.object({
      available: z.boolean(),
      sandbox: sandboxSummarySchema.nullable(),
      pods: z.array(sandboxPodSchema).default([]),
    }),
  );

/**
 * `POST /api/sandboxes/automation`'s body for a named environment: a
 * team's pods are opened by environment, and `ordinal` names the pod (the
 * shell picker's choice) or is `null` for the one with headroom. The personal
 * open sends no body.
 */
export interface SandboxAutomationOpenTarget {
  readonly environmentId: string;
  readonly ordinal: number | null;
}

/**
 * `POST /api/sandboxes/automation` (`200` awake, `202` still creating or
 * starting): the row as the open left it.
 */
export interface SandboxAutomationOpenResponse {
  readonly sandbox: SandboxSummary;
}

export const sandboxAutomationOpenResponseSchema: z.ZodType<SandboxAutomationOpenResponse> =
  lazySchema(() =>
    z.object({
      sandbox: sandboxSummarySchema,
    }),
  );

/**
 * `POST /api/sandboxes/:id/{suspend,resume,stop,start}` (`200` at rest,
 * `202` still moving): the row where the operation left it, which need not be
 * the verb's own state (a suspend whose purge found the guest unreachable
 * lands `stopped`).
 */
export interface SandboxLifecycleVerbResponse {
  readonly sandbox: SandboxSummary;
}

export const sandboxLifecycleVerbResponseSchema: z.ZodType<SandboxLifecycleVerbResponse> =
  lazySchema(() =>
    z.object({
      sandbox: sandboxSummarySchema,
    }),
  );

/**
 * Free-form shape bounds of one provider. The server rounds a request UP to
 * `cpuStep` / `memoryStepMb` from the minimums, then checks the memory per
 * vCPU of the ROUNDED shape against the ratio range.
 */
export interface SandboxShapeBounds {
  readonly cpuMin: number;
  readonly cpuMax: number;
  readonly cpuStep: number;
  readonly memoryPerCpuMinMb: number;
  readonly memoryPerCpuMaxMb: number;
  readonly memoryMinMb: number;
  readonly memoryMaxMb: number;
  readonly memoryStepMb: number;
  readonly diskMinMb: number;
  readonly diskMaxMb: number;
  readonly diskDefaultMb: number;
}

export const sandboxShapeBoundsSchema: z.ZodType<SandboxShapeBounds> =
  lazySchema(() =>
    z.object({
      cpuMin: z.number().positive(),
      cpuMax: z.number().positive(),
      cpuStep: z.number().positive(),
      memoryPerCpuMinMb: z.number().positive(),
      memoryPerCpuMaxMb: z.number().positive(),
      memoryMinMb: z.number().int().positive(),
      memoryMaxMb: z.number().int().positive(),
      memoryStepMb: z.number().int().positive(),
      diskMinMb: z.number().int().positive(),
      diskMaxMb: z.number().int().positive(),
      diskDefaultMb: z.number().int().positive(),
    }),
  );

export interface SandboxCatalogueRegion {
  readonly id: string;
  readonly label: string;
  /** The price of the provider's SMALLEST shape here, for a "from" line. */
  readonly fromPriceMcPerHour: SandboxHourlyPrice;
}

export const sandboxCatalogueRegionSchema: z.ZodType<SandboxCatalogueRegion> =
  lazySchema(() =>
    z.object({
      id: z.string().min(1),
      label: z.string(),
      fromPriceMcPerHour: sandboxHourlyPriceSchema,
    }),
  );

export interface SandboxCatalogueProvider {
  readonly provider: string;
  readonly os: readonly SandboxOs[];
  readonly shape: SandboxShapeBounds;
  /** What a suspend keeps: memory and disk, disk only, or nothing. */
  readonly suspendFidelity: string;
  readonly stoppedStorage: string;
  readonly wakeClass: string;
  readonly dockerInGuest: boolean;
  /**
   * False when this deployment's account cannot create the provider's
   * smallest shape: its plan's per-sandbox memory cap is below what a
   * sandbox needs. The form offers no shape for it and says sandboxes can't
   * be created; a create is refused `shape_not_offered` with
   * `provider-plan-too-small`. True from a server that predates the field.
   */
  readonly creatable: boolean;
  /**
   * Why {@link creatable} is false ({@link SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY});
   * null when it is true, and from a server that predates the field.
   */
  readonly notCreatableReason: string | null;
  /** Regions with a configured price only; the FIRST is the server's default. */
  readonly regions: readonly SandboxCatalogueRegion[];
}

/** The plan's per-sandbox memory cap is below the provider's smallest shape. */
export const SANDBOX_NOT_CREATABLE_REASON_PLAN_MEMORY =
  "plan-memory-below-host-minimum";

export const sandboxCatalogueProviderSchema: z.ZodType<SandboxCatalogueProvider> =
  lazySchema(() =>
    z.object({
      provider: z.string().min(1),
      os: z.array(sandboxOsSchema),
      shape: sandboxShapeBoundsSchema,
      suspendFidelity: z.string(),
      stoppedStorage: z.string(),
      wakeClass: z.string(),
      dockerInGuest: z.boolean(),
      creatable: z.boolean().default(true),
      notCreatableReason: z.string().nullable().default(null),
      regions: z.array(sandboxCatalogueRegionSchema),
    }),
  );

/** `GET /api/sandboxes/catalogue`. */
export interface SandboxCatalogue {
  readonly providers: readonly SandboxCatalogueProvider[];
}

export const sandboxCatalogueSchema: z.ZodType<SandboxCatalogue> = lazySchema(
  () =>
    z.object({
      providers: z.array(sandboxCatalogueProviderSchema),
    }),
);

/**
 * `POST /api/sandboxes` body. Every `null` takes the server's default:
 * `diskMb` the provider's default disk, `region` the provider's first priced
 * region, `idleMinutes` 30 minutes. `createdByHostId` / `createdByAgentId`
 * name the host and agent that asked (both `null` from the GUI form); `burst`
 * is false from the form.
 */
export interface SandboxCreateRequest {
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number | null;
  readonly region: string | null;
  /** 1 to 191 characters. */
  readonly displayName: string;
  /**
   * Two minutes or more, or `null` for the default. There is no upper
   * bound; a period under the floor is refused, never clamped.
   */
  readonly idleMinutes: number | null;
  readonly burst: boolean;
  readonly createdByHostId: string | null;
  readonly createdByAgentId: string | null;
  /**
   * The environment to create into: a team's, from the form's Belongs to;
   * `null` for the caller's own principal's environment, which is
   * what a server before environments always did.
   */
  readonly environmentId: string | null;
  /**
   * Minutes the sandbox may rest before it is destroyed, or `null` for the
   * configuration's default. Unlike a patch, `null` here never means "never".
   */
  readonly destroyAfterRestingMinutes: number | null;
  /** The task an agent creates the sandbox for; `null` from the GUI. */
  readonly createdByTaskId: string | null;
  /**
   * The client's idempotency key for one send: a repeat create with the same
   * id answers the row the first one made instead of creating a second
   * sandbox. `null` when the caller does not retry.
   */
  readonly clientRequestId: string | null;
}

/**
 * `PATCH /api/sandboxes/:id` body: rename the row and change its idle and
 * resting periods. Each `null` leaves that setting unchanged. A changed
 * resting period restarts the resting clock from the save. The answer is
 * `200 { sandbox }`, or `sandbox_not_found`.
 */
export interface SandboxPatchRequest {
  /** 1 to 191 characters, or `null` to keep the name. */
  readonly displayName: string | null;
  /** Two minutes or more, or `null` to keep the idle period. */
  readonly idleMinutes: number | null;
  /**
   * Minutes the row may rest before it is destroyed; `0` means never (so
   * `null` can keep meaning unchanged), or `null` to keep the period.
   */
  readonly destroyAfterRestingMinutes: number | null;
}

export const sandboxPatchRequestSchema: z.ZodType<SandboxPatchRequest> =
  lazySchema(() =>
    z.object({
      displayName: z.string().min(1).max(191).nullable(),
      idleMinutes: z.number().int().min(2).nullable(),
      destroyAfterRestingMinutes: z.number().int().nonnegative().nullable(),
    }),
  );

/** `202` body of `POST /api/sandboxes`: the row exists, in `creating`. */
export interface SandboxCreateAccepted {
  readonly sandboxId: string;
  readonly hostId: string;
  readonly sandbox: SandboxSummary;
}

export const sandboxCreateAcceptedSchema: z.ZodType<SandboxCreateAccepted> =
  lazySchema(() =>
    z.object({
      sandboxId: z.string().min(1),
      hostId: z.string().min(1),
      sandbox: sandboxSummarySchema,
    }),
  );

/**
 * The control plane's typed refusal body: `{ code, ... }`, the rest per code.
 * Known codes:
 *
 *  - `shape_not_offered` (`400`): `reason` names which bound the shape broke
 *    (`os-not-offered`, `region-not-offered`, `cpus-out-of-range`,
 *    `memory-out-of-range`, `memory-per-cpu-out-of-range`, `disk-out-of-range`,
 *    `provider-plan-too-small`: the account's plan cannot create any shape
 *    of the provider, see `SandboxCatalogueProvider.creatable`).
 *  - `insufficient_credit` (`402`): the create gate refused; `reason`
 *    (`denied`, `unverified`, `unsupported-subscription`), the shortfall
 *    (`null` when the balance is unknown) and the burn it was computed from.
 *  - `provider_unavailable` (`503`), `provider_failed` (`502`, with the row,
 *    now `failed`).
 *  - `sandbox_transition_conflict` (`409`): the row is mid-transition.
 *  - `sandbox_busy` (`409`): a suspend or stop found the guest in use (an
 *    agent turn, a live shell, an attached client); the row is `awake` again.
 *  - `sandbox_frozen` (`402`): a wake verb on a row frozen for lack of
 *    credits.
 *  - `sandbox_not_found` (`404`).
 *  - `verb_not_available` (`501`): the lifecycle verb (suspend, resume, stop,
 *    start) is not served by this server yet.
 */
export interface SandboxRefusalBody {
  readonly code: string;
  readonly reason?: string | null;
  readonly shortfallMc?: number | null;
  readonly newRateMcPerHour?: number | null;
  readonly currentAwakeBurnMcPerHour?: number | null;
  /**
   * A server-composed sentence a refusal carries for the person, rendered
   * verbatim (`team_pods_full` names the team and its admins).
   */
  readonly message?: string | null;
}

export const sandboxRefusalBodySchema: z.ZodType<SandboxRefusalBody> =
  lazySchema(() =>
    z.object({
      code: z.string().min(1),
      reason: z.string().nullable().optional(),
      shortfallMc: z.number().nullable().optional(),
      newRateMcPerHour: z.number().nullable().optional(),
      currentAwakeBurnMcPerHour: z.number().nullable().optional(),
      message: z.string().nullable().optional(),
    }),
  );

export const SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED = "shape_not_offered";
export const SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT = "insufficient_credit";
export const SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE = "provider_unavailable";
export const SANDBOX_REFUSAL_CODE_PROVIDER_FAILED = "provider_failed";
export const SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT =
  "sandbox_transition_conflict";
export const SANDBOX_REFUSAL_CODE_BUSY = "sandbox_busy";
export const SANDBOX_REFUSAL_CODE_FROZEN = "sandbox_frozen";
export const SANDBOX_REFUSAL_CODE_NOT_FOUND = "sandbox_not_found";
export const SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE = "verb_not_available";
/** Every team pod awake at its cap; the refusal's `message` says so. */
export const SANDBOX_REFUSAL_CODE_TEAM_PODS_FULL = "team_pods_full";
/**
 * The create's environment is not the caller's to create into: a team they
 * are not an accepted member of, or no such environment. The server names no
 * team; the form names the one the person picked.
 */
export const SANDBOX_REFUSAL_CODE_ENVIRONMENT_NOT_FOUND =
  "environment_not_found";
/** The create could not check the environment (authn unreachable). */
export const SANDBOX_REFUSAL_CODE_ENVIRONMENT_UNAVAILABLE =
  "environment_unavailable";

// -----------------------------------------------------------------------------
// Lifecycle verbs
// -----------------------------------------------------------------------------

/**
 * `POST /api/sandboxes/:id/<verb>`. `resume` and `start` both wake the row
 * from whichever resting state it is in. The server answers `200 { sandbox }`
 * at rest, `202 { sandbox }` when it is still moving at its 300 s deadline,
 * and the typed refusals above.
 */
export type SandboxLifecycleVerb = "suspend" | "resume" | "stop" | "start";

// -----------------------------------------------------------------------------
// Cost view
// -----------------------------------------------------------------------------

/** The states the meter bills: awake is compute, the other two storage. */
export type SandboxBilledState = "awake" | "suspended" | "stopped";

/** Consecutive same-state charges, merged into one span. */
export interface SandboxCostSegment {
  readonly state: SandboxBilledState;
  /** Epoch milliseconds. */
  readonly fromAt: number;
  readonly toAt: number;
  readonly millicredits: number;
}

export const sandboxCostSegmentSchema: z.ZodType<SandboxCostSegment> =
  lazySchema(() =>
    z.object({
      state: z.enum(["awake", "suspended", "stopped"]),
      fromAt: z.number(),
      toAt: z.number(),
      millicredits: z.number().nonnegative(),
    }),
  );

/**
 * One sandbox's cost, read from the control plane's own ledger
 * (`GET /api/sandboxes/:id/cost`, and each row of `GET /api/sandboxes/cost`).
 */
export interface SandboxCost {
  readonly sandboxId: string;
  /** What the row accrues now; 0 while frozen or for a free (Automations) row. */
  readonly currentRateMillicreditsPerHour: number;
  readonly state: HostSandboxState;
  readonly frozen: boolean;
  /** Settled charges since the row was created. */
  readonly charged: {
    readonly computeMillicredits: number;
    readonly storageMillicredits: number;
    readonly sinceCreatedAt: number;
  };
  /** Closed segments the meter has not settled yet. */
  readonly pendingMillicredits: number;
  /** The ledger as a timeline, oldest first, over the latest charge rows. */
  readonly segments: readonly SandboxCostSegment[];
  /**
   * Today's (UTC day) charges plus the open segment's accrual up to now; `0`
   * from a server before the field.
   */
  readonly todayMillicredits: number;
}

export const sandboxCostSchema: z.ZodType<SandboxCost> = lazySchema(() =>
  z.object({
    sandboxId: z.string().min(1),
    currentRateMillicreditsPerHour: z.number().nonnegative(),
    state: z.enum(HOST_SANDBOX_STATES),
    frozen: z.boolean(),
    charged: z.object({
      computeMillicredits: z.number().nonnegative(),
      storageMillicredits: z.number().nonnegative(),
      sinceCreatedAt: z.number(),
    }),
    pendingMillicredits: z.number().nonnegative(),
    segments: z.array(sandboxCostSegmentSchema),
    todayMillicredits: z.number().nonnegative().default(0),
  }),
);

/** `GET /api/sandboxes/cost`: every listed sandbox's cost and the user's burn. */
export interface UserSandboxCost {
  readonly sandboxes: readonly SandboxCost[];
  /** The compute rates of the user's awake, unfrozen rows: the gate's burn. */
  readonly awakeBurnMillicreditsPerHour: number;
  /**
   * The viewer's own share of today's (UTC day) cost across the rows
   * returned; `0` from a server before the field.
   */
  readonly todayYoursMillicredits: number;
}

export const userSandboxCostSchema: z.ZodType<UserSandboxCost> = lazySchema(
  () =>
    z.object({
      sandboxes: z.array(sandboxCostSchema),
      awakeBurnMillicreditsPerHour: z.number().nonnegative(),
      todayYoursMillicredits: z.number().nonnegative().default(0),
    }),
);
