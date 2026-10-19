/**
 * What the app reads and writes about a sandbox's secrets on the broker
 * (authn), with the signed-in user's bearer: the grants summary a sandbox's
 * card shows, and the decision on an agent's grant request.
 *
 * A client holds no secret and no control over one beyond these two calls:
 * the values, their bindings and every other change live on the dashboard.
 * Neither body carries a value, a placeholder or an id beyond a name.
 *
 * Read tolerantly, as `sandbox-control.ts` is: the broker ships on its own
 * schedule, so a field it adds is ignored, and the open strings below
 * (`kind`, `protocol`, `mode`, `source`, a request's `status`) are compared
 * against the lists here and never rejected for being new.
 */
import { z } from "zod";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";

// ─── `GET /api/v3/environments/:environmentId/secrets/hosts/:hostId/grants` ─

/** How a sandbox holds a secret. Anything else is shown as its own word. */
export const SANDBOX_GRANT_MODE_BROKERED = "brokered";
export const SANDBOX_GRANT_MODE_EXPOSED = "exposed";

/**
 * One destination a granted secret is brokered to. `route` is the id that
 * also names it in the sandbox host's egress events and in
 * `SandboxSummary.routes`, which is how the card puts a destination's
 * readiness and its last refusal beside it.
 */
export interface SandboxGrantRoute {
  readonly route: string;
  readonly destination: string;
  readonly port: number | null;
  /**
   * Why the broker knows this route cannot be used right now, or `null` when
   * it knows of nothing: {@link SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE} while
   * the route's private connector is not answering. Any other word is a
   * reason a newer broker names; the route is still one that cannot be used.
   */
  readonly unready: string | null;
}

/** The route's private connector is offline. */
export const SANDBOX_ROUTE_UNREADY_CONNECTOR_OFFLINE = "connector_offline";

export const sandboxGrantRouteSchema: z.ZodType<SandboxGrantRoute> = lazySchema(
  () =>
    z.object({
      route: z.string().min(1),
      destination: z.string().min(1),
      port: z.number().int().positive().nullable().default(null),
      unready: z.string().min(1).nullable().default(null),
    }),
);

/**
 * One secret a sandbox may use. `routes` is empty for an exposed secret: its
 * value is on the sandbox and nothing is brokered. `connectorName` is set
 * when its destinations sit behind a private connector.
 */
export interface SandboxGrant {
  readonly secretName: string;
  readonly kind: string;
  readonly protocol: string;
  readonly mode: string;
  /** `default`, `inherited` or `approved`: why this sandbox has it. */
  readonly source: string;
  readonly connectorName: string | null;
  readonly routes: readonly SandboxGrantRoute[];
  /**
   * The secret's latest rotation as this sandbox sees it, or `null` when its
   * value has never been replaced (or the broker does not report it here).
   */
  readonly rotation: SandboxGrantRotation | null;
}

/**
 * One evidence entry of a class's `rotation_ack` receipt. `kind` is read as a
 * string (known: `session_closed`, `cache_cleared`, `probe_refused`), so an
 * evidence kind newer than this build still parses; only a known kind is
 * proof. `count` is null where the rotation wire allows it.
 */
export interface SandboxGrantRotationEvidence {
  readonly kind: string;
  readonly count: number | null;
}

/**
 * One worker class serving this sandbox's routes for the secret, and what it
 * proved. `status` is read as a string (known: `acknowledged`, `missing`,
 * `contained_by_expiry`).
 */
export interface SandboxGrantRotationClass {
  readonly workerClass: string;
  readonly status: string;
  readonly evidence: readonly SandboxGrantRotationEvidence[] | null;
}

/**
 * A grant's rotation: `state` read as a string (known: `accepted`,
 * `enforcing`, `enforced`, `failed`) and the classes that owe or wrote an
 * acknowledgement for this sandbox.
 */
export interface SandboxGrantRotation {
  readonly state: string;
  readonly classes: readonly SandboxGrantRotationClass[];
}

export const sandboxGrantRotationSchema: z.ZodType<SandboxGrantRotation> =
  lazySchema(() =>
    z.object({
      state: z.string().min(1),
      classes: z
        .array(
          z.object({
            workerClass: z.string().min(1),
            status: z.string().min(1),
            evidence: z
              .array(
                z.object({
                  kind: z.string().min(1),
                  count: z.number().int().nonnegative().nullable(),
                }),
              )
              .nullable(),
          }),
        )
        .default([]),
    }),
  );

export const sandboxGrantSchema: z.ZodType<SandboxGrant> = lazySchema(() =>
  z.object({
    secretName: z.string().min(1),
    kind: z.string(),
    protocol: z.string(),
    mode: z.string(),
    source: z.string(),
    connectorName: z.string().nullable().default(null),
    routes: z.array(sandboxGrantRouteSchema).default([]),
    rotation: sandboxGrantRotationSchema.nullable().default(null),
  }),
);

export interface SandboxGitHubInstallation {
  readonly account: string;
  /** `all` or `selected`. */
  readonly repositorySelection: string;
}

/** What git on the sandbox can reach through the Traycer GitHub App. */
export interface SandboxGitHubAccess {
  /** Whether the user's GitHub identity is linked at all. */
  readonly linked: boolean;
  readonly installations: readonly SandboxGitHubInstallation[];
}

export const sandboxGitHubAccessSchema: z.ZodType<SandboxGitHubAccess> =
  lazySchema(() =>
    z.object({
      linked: z.boolean(),
      installations: z
        .array(
          z.object({
            account: z.string(),
            repositorySelection: z.string(),
          }),
        )
        .default([]),
    }),
  );

export interface SandboxGrantsSummary {
  /** The grant set's version; moves on every grant change. */
  readonly version: number;
  readonly grants: readonly SandboxGrant[];
  /** `null` from a broker that does not report GitHub access here. */
  readonly github: SandboxGitHubAccess | null;
}

export const sandboxGrantsSummarySchema: z.ZodType<SandboxGrantsSummary> =
  lazySchema(() =>
    z.object({
      version: z.number(),
      grants: z.array(sandboxGrantSchema),
      github: sandboxGitHubAccessSchema.nullable().default(null),
    }),
  );

// ─── `POST /api/v3/environments/:environmentId/secrets/requests/:id/decide` ─

/**
 * The three answers to an agent's grant request:
 *
 *  - `approve`: this sandbox gets the secret for its lifetime.
 *  - `approve_default`: that, and every future sandbox gets it by default.
 *  - `decline`: nothing is granted and the agent is told.
 */
export const SECRET_REQUEST_DECISIONS = [
  "approve",
  "approve_default",
  "decline",
] as const;
export type SecretRequestDecision = (typeof SECRET_REQUEST_DECISIONS)[number];

/** A grant request's states; `pending` until decided or expired (24 h). */
export const SECRET_REQUEST_STATUSES = [
  "pending",
  "approved",
  "approved_default",
  "declined",
  "expired",
] as const;
export type SecretRequestStatus = (typeof SECRET_REQUEST_STATUSES)[number];

/** The status each decision leaves a request in. */
export const SECRET_REQUEST_STATUS_OF_DECISION: Record<
  SecretRequestDecision,
  SecretRequestStatus
> = {
  approve: "approved",
  approve_default: "approved_default",
  decline: "declined",
};

/**
 * The `409` code for a request that names only a destination: there is no
 * secret to grant until the user stores one on the dashboard.
 */
export const SECRET_REQUEST_CODE_SECRET_REQUIRED = "secret_required";

/**
 * The body of a `200` (the request now stands at `status`; repeating the same
 * decision answers the same) and of a `409` (the request stands at `status`
 * and this decision did not change it: it was decided otherwise, it expired,
 * or `code` says what is missing).
 */
export interface SecretRequestDecideBody {
  readonly status: string;
  readonly code: string | null;
  /**
   * The display name of the person whose answer settled the request, or
   * `null` (an expired request, or a broker that does not report it). On a
   * team request it lets every other admin read who answered.
   */
  readonly decidedBy: string | null;
}

export const secretRequestDecideBodySchema: z.ZodType<SecretRequestDecideBody> =
  lazySchema(() =>
    z.object({
      status: z.string().min(1),
      code: z.string().nullable().default(null),
      decidedBy: z.string().min(1).nullable().default(null),
    }),
  );
