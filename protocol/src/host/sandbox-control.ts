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
  /** `null` when this server has no price configured for the provider. */
  readonly priceMcPerHour: SandboxHourlyPrice | null;
}

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
    priceMcPerHour: sandboxHourlyPriceSchema.nullable(),
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
  /** Regions with a configured price only; the FIRST is the server's default. */
  readonly regions: readonly SandboxCatalogueRegion[];
}

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

/** The longest idle period a create may set: one week, in minutes. */
export const SANDBOX_MAX_IDLE_MINUTES = 7 * 24 * 60;

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
  /** 1 to {@link SANDBOX_MAX_IDLE_MINUTES}, or `null` for the default. */
  readonly idleMinutes: number | null;
  readonly burst: boolean;
  readonly createdByHostId: string | null;
  readonly createdByAgentId: string | null;
}

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
 *    `memory-out-of-range`, `memory-per-cpu-out-of-range`, `disk-out-of-range`).
 *  - `insufficient_credit` (`402`): the create gate refused; `reason`
 *    (`denied`, `unverified`, `unsupported-subscription`), the shortfall
 *    (`null` when the balance is unknown) and the burn it was computed from.
 *  - `provider_unavailable` (`503`), `provider_failed` (`502`, with the row,
 *    now `failed`).
 *  - `sandbox_transition_conflict` (`409`): the row is mid-transition.
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
}

export const sandboxRefusalBodySchema: z.ZodType<SandboxRefusalBody> =
  lazySchema(() =>
    z.object({
      code: z.string().min(1),
      reason: z.string().nullable().optional(),
      shortfallMc: z.number().nullable().optional(),
      newRateMcPerHour: z.number().nullable().optional(),
      currentAwakeBurnMcPerHour: z.number().nullable().optional(),
    }),
  );

export const SANDBOX_REFUSAL_CODE_SHAPE_NOT_OFFERED = "shape_not_offered";
export const SANDBOX_REFUSAL_CODE_INSUFFICIENT_CREDIT = "insufficient_credit";
export const SANDBOX_REFUSAL_CODE_PROVIDER_UNAVAILABLE = "provider_unavailable";
export const SANDBOX_REFUSAL_CODE_PROVIDER_FAILED = "provider_failed";
export const SANDBOX_REFUSAL_CODE_TRANSITION_CONFLICT =
  "sandbox_transition_conflict";
export const SANDBOX_REFUSAL_CODE_NOT_FOUND = "sandbox_not_found";
export const SANDBOX_REFUSAL_CODE_VERB_NOT_AVAILABLE = "verb_not_available";
