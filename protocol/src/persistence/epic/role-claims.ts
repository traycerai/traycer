import { z } from "zod";

/**
 * Task-local agent role claims.
 * 1. **One normalizer.** Wire schemas, the persisted record, the host, and the CLI all reach role text through `normalizeRoleText`, so the vocabulary cannot drift between surfaces.
 */

const ROLE_NAME_MAX_CODE_POINTS = 48;
const ROLE_SCOPE_MAX_CODE_POINTS = 120;

// U+001F (unit separator) joins the two halves of an identity key.
// Role and scope can never contain it: it is C0, and step 3 below rejects every C0/C1 that survives whitespace folding.
const IDENTITY_KEY_SEPARATOR = "\u001F";

// Every Unicode whitespace run - including tab, LF, CR, and NBSP - folds to a
// single U+0020. `\s` with the `u` flag already covers all of them.
const WHITESPACE_RUN = /\s+/gu;

// Applied only AFTER whitespace folding, so tab/LF/CR/VT/FF/NBSP have already become spaces and never reach it.
const SURVIVING_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/u;

/** NFC, fold whitespace runs to a single space, trim. */
export function normalizeRoleText(raw: string): string {
  return raw.normalize("NFC").replace(WHITESPACE_RUN, " ").trim();
}

function roleTextSchema(maxCodePoints: number, label: string) {
  return (
    z
      .string()
      // `.overwrite()`, not `.transform()`: it normalizes in place while keeping the schema a string.
      // A `.transform()` produces a pipe, and `z.toJSONSchema` -- which the RPC registry runs over every registered contract -- throws outright on transforms ("Transforms cannot be represented in JSON Schema").
      .overwrite(normalizeRoleText)
      .refine((value) => value.length > 0, {
        message: `${label} must not be empty`,
      })
      .refine((value) => !SURVIVING_CONTROL_CHARACTER.test(value), {
        message: `${label} must not contain control characters`,
      })
      .refine((value) => [...value].length <= maxCodePoints, {
        message: `${label} must be at most ${maxCodePoints} characters`,
      })
  );
}

// Free text, deliberately no enum: the vocabulary is open (a hard-coded Planner/Reviewer/QA enum is explicitly the wrong shape here).
export const roleNameSchema = roleTextSchema(ROLE_NAME_MAX_CODE_POINTS, "role");
export const roleScopeSchema = roleTextSchema(
  ROLE_SCOPE_MAX_CODE_POINTS,
  "scope",
);

export const roleClaimSchema = z.object({
  claimId: z.uuid(),
  agentId: z.string().min(1),
  // Account scope, mirroring chat.userId / tuiAgent.userId. The visibility
  // projection filters on this first.
  userId: z.string().min(1),
  role: roleNameSchema,
  scope: roleScopeSchema,
  claimedAt: z.number().int().nonnegative(),
});

export type RoleClaim = z.infer<typeof roleClaimSchema>;

/** The map key IS the claimId. */
export const roleClaimsSchema = z
  .record(z.uuid(), roleClaimSchema)
  .refine(
    (claims) =>
      Object.entries(claims).every(([key, claim]) => key === claim.claimId),
    { message: "roleClaims key must equal claim.claimId" },
  );

export type RoleClaims = z.infer<typeof roleClaimsSchema>;

/**
 * Case- and whitespace-insensitive identity of a claim, so `Planner` and `planner` are the same claim and near-duplicates get caught.
 * Derived on demand and never persisted, so it cannot drift from the stored text.
 */
export function roleClaimIdentityKey(claim: {
  readonly role: string;
  readonly scope: string;
}): string {
  return `${normalizeRoleText(claim.role).toLowerCase()}${IDENTITY_KEY_SEPARATOR}${normalizeRoleText(
    claim.scope,
  ).toLowerCase()}`;
}

export type RoleClaimVisibility = {
  /** The AUTHENTICATED caller - never an id taken from the request body. */
  readonly userId: string;
  /** Agents currently live in this epic. */
  readonly liveAgentIds: ReadonlySet<string>;
};

/** The single read projection. */
export function projectVisibleRoleClaims(
  claims: readonly RoleClaim[],
  visibility: RoleClaimVisibility,
): RoleClaim[] {
  return claims
    .filter((claim) => claim.userId === visibility.userId)
    .filter((claim) => visibility.liveAgentIds.has(claim.agentId))
    .toSorted(
      (left, right) =>
        left.claimedAt - right.claimedAt ||
        compareClaimIds(left.claimId, right.claimId),
    );
}

/** Locale-INDEPENDENT lexicographic compare. */
function compareClaimIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
