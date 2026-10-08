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
 * ⚠️ CROSS-REPO MIRROR of `traycer-server/src/routes/api/sandboxes/`. The OSS
 * clients cannot import the server's types, so the wire shape is mirrored here,
 * where the host's agent tools can read it too.
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

/** Price per hour of one sandbox in each billed state, in millicredits. */
export interface SandboxRate {
  readonly awakeMcPerHour: number;
  readonly suspendedMcPerHour: number;
  readonly stoppedMcPerHour: number;
}

export const sandboxRateSchema: z.ZodType<SandboxRate> = lazySchema(() =>
  z.object({
    awakeMcPerHour: z.number().nonnegative(),
    suspendedMcPerHour: z.number().nonnegative(),
    stoppedMcPerHour: z.number().nonnegative(),
  }),
);

/** One sandbox as `GET /api/sandboxes` and `GET /api/sandboxes/:id` return it. */
export interface SandboxSummary {
  /** The sandbox id: the path segment of every `/api/sandboxes/:id` verb. */
  readonly id: string;
  /** The host id the sandbox enrolled under; joins the host list row. */
  readonly hostId: string;
  readonly kind: SandboxKind;
  readonly provider: string;
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly diskMb: number;
  readonly region: string;
  readonly displayName: string;
  readonly state: HostSandboxState;
  readonly frozen: boolean;
  /** `null` = never suspended for idleness. */
  readonly idleMinutes: number | null;
  /** Created by an agent for one task; offered in no picker. */
  readonly burst: boolean;
  readonly rate: SandboxRate;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds of the last activity heartbeat, `null` before one. */
  readonly lastActivityAt: number | null;
  /** The vendor's or the lifecycle's code on a `failed` row, else `null`. */
  readonly failureCode: string | null;
}

export const sandboxSummarySchema: z.ZodType<SandboxSummary> = lazySchema(() =>
  z.object({
    id: z.string().min(1),
    hostId: z.string().min(1),
    kind: sandboxKindSchema,
    provider: z.string(),
    os: sandboxOsSchema,
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    diskMb: z.number().int().nonnegative(),
    region: z.string(),
    displayName: z.string(),
    state: z.enum(HOST_SANDBOX_STATES),
    frozen: z.boolean(),
    idleMinutes: z.number().int().positive().nullable(),
    burst: z.boolean(),
    rate: sandboxRateSchema,
    createdAt: z.number(),
    lastActivityAt: z.number().nullable(),
    failureCode: z.string().nullable(),
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
 * Free-form shape bounds of one provider: vCPU in `cpuStep` increments between
 * the bounds, memory as a per-vCPU ratio range.
 */
export interface SandboxShapeBounds {
  readonly cpuMin: number;
  readonly cpuMax: number;
  readonly cpuStep: number;
  readonly memoryPerCpuMinMb: number;
  readonly memoryPerCpuMaxMb: number;
  readonly memoryStepMb: number;
}

export const sandboxShapeBoundsSchema: z.ZodType<SandboxShapeBounds> =
  lazySchema(() =>
    z.object({
      cpuMin: z.number().positive(),
      cpuMax: z.number().positive(),
      cpuStep: z.number().positive(),
      memoryPerCpuMinMb: z.number().positive(),
      memoryPerCpuMaxMb: z.number().positive(),
      memoryStepMb: z.number().int().positive(),
    }),
  );

/**
 * A region's price per hour, linear in the shape: the server's catalogue
 * computes `awake = cpus × awakeMcPerCpuHour + memoryGib × awakeMcPerGibHour`
 * and the parked states from memory and disk alone. Carried as components so
 * a form can price a free-form shape without a round trip per keystroke.
 */
export interface SandboxRegionPricing {
  readonly awakeMcPerCpuHour: number;
  readonly awakeMcPerGibHour: number;
  readonly suspendedMcPerGibHour: number;
  readonly stoppedMcPerGibHour: number;
}

export const sandboxRegionPricingSchema: z.ZodType<SandboxRegionPricing> =
  lazySchema(() =>
    z.object({
      awakeMcPerCpuHour: z.number().nonnegative(),
      awakeMcPerGibHour: z.number().nonnegative(),
      suspendedMcPerGibHour: z.number().nonnegative(),
      stoppedMcPerGibHour: z.number().nonnegative(),
    }),
  );

export interface SandboxCatalogueRegion {
  readonly id: string;
  readonly label: string;
  readonly pricing: SandboxRegionPricing;
}

export const sandboxCatalogueRegionSchema: z.ZodType<SandboxCatalogueRegion> =
  lazySchema(() =>
    z.object({
      id: z.string().min(1),
      label: z.string(),
      pricing: sandboxRegionPricingSchema,
    }),
  );

export interface SandboxCatalogueProvider {
  readonly provider: string;
  readonly os: readonly SandboxOs[];
  readonly shape: SandboxShapeBounds;
  readonly regions: readonly SandboxCatalogueRegion[];
}

export const sandboxCatalogueProviderSchema: z.ZodType<SandboxCatalogueProvider> =
  lazySchema(() =>
    z.object({
      provider: z.string().min(1),
      os: z.array(sandboxOsSchema),
      shape: sandboxShapeBoundsSchema,
      regions: z.array(sandboxCatalogueRegionSchema),
    }),
  );

/** `GET /api/sandboxes/catalogue`. */
export interface SandboxCatalogue {
  readonly providers: readonly SandboxCatalogueProvider[];
  /** The region nearest the caller as the server judged it, or `null`. */
  readonly nearestRegionId: string | null;
}

export const sandboxCatalogueSchema: z.ZodType<SandboxCatalogue> = lazySchema(
  () =>
    z.object({
      providers: z.array(sandboxCatalogueProviderSchema),
      nearestRegionId: z.string().nullable(),
    }),
);

/**
 * `POST /api/sandboxes` body. `createdByHostId` / `createdByAgentId` name the
 * host and agent that asked (both `null` from the GUI form); `burst` is false
 * from the form (an agent-created sandbox defaults to burst).
 */
export interface SandboxCreateRequest {
  readonly name: string;
  readonly os: SandboxOs;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly region: string;
  readonly idleMinutes: number | null;
  readonly burst: boolean;
  readonly createdByHostId: string | null;
  readonly createdByAgentId: string | null;
}

/** `202` body of `POST /api/sandboxes`. */
export interface SandboxCreateAccepted {
  readonly sandboxId: string;
  readonly hostId: string;
}

export const sandboxCreateAcceptedSchema: z.ZodType<SandboxCreateAccepted> =
  lazySchema(() =>
    z.object({
      sandboxId: z.string().min(1),
      hostId: z.string().min(1),
    }),
  );

/**
 * The control plane's typed refusal body: `{ code, ... }`. Known codes:
 *
 *  - `verb_not_available` (`501`): the lifecycle verb (suspend, resume, stop,
 *    start) is not served by this server yet.
 *  - `sandbox_frozen`: the sandbox is frozen for lack of credits.
 *  - `insufficient_credits` (`402`): the create or wake gate refused; the
 *    body names the shortfall and the hourly burn the gate counted.
 *  - `shape_outside_catalogue` (`400`): the requested shape is outside the
 *    catalogue's bounds.
 *  - `sandbox_transition_conflict` (`409`): the row is mid-transition.
 */
export interface SandboxRefusalBody {
  readonly code: string;
  readonly message?: string | null;
  readonly shortfallMc?: number | null;
  readonly burnMcPerHour?: number | null;
}

export const sandboxRefusalBodySchema: z.ZodType<SandboxRefusalBody> =
  lazySchema(() =>
    z.object({
      code: z.string().min(1),
      message: z.string().nullable().optional(),
      shortfallMc: z.number().nullable().optional(),
      burnMcPerHour: z.number().nullable().optional(),
    }),
  );

export const SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE = "verb_not_available";
export const SANDBOX_REFUSAL_CODE_FROZEN = "sandbox_frozen";
export const SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDITS = "insufficient_credits";
export const SANDBOX_REFUSAL_CODE_SHAPE_OUTSIDE_CATALOGUE =
  "shape_outside_catalogue";
export const SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT =
  "sandbox_transition_conflict";
