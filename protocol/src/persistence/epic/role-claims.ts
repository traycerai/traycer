import { z } from "zod";

/**
 * Task-local agent role claims.
 *
 * An agent designates itself with a free-text role name over a free-text
 * scope ("Planner - authentication migration"). Claims are durable: they
 * survive stopped turns, disconnected monitors, and resumes until the agent
 * relinquishes them or is deleted.
 *
 * Not to be confused with `epic.batchUpdateRoles`, which is the *collaborator
 * ACL* (owner/editor/viewer). These are agent responsibilities, not
 * permissions - they grant nothing.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **One normalizer.** Wire schemas, the persisted record, the host, and the
 *    CLI all reach role text through `normalizeRoleText`, so the vocabulary
 *    cannot drift between surfaces.
 * 2. **One visibility projection.** Every surface that can *show* a claim -
 *    list, overlap detection, overlap results, prompt propagation - reads it
 *    through `projectVisibleRoleClaims`, which filters by the authenticated
 *    account first and live agents second. There is no second read path, so
 *    there is only one place cross-account leakage could occur.
 */

const ROLE_NAME_MAX_CODE_POINTS = 48;
const ROLE_SCOPE_MAX_CODE_POINTS = 120;

// U+001F (unit separator) joins the two halves of an identity key. Role and
// scope can never contain it: it is C0, and step 3 below rejects every C0/C1
// that survives whitespace folding. So the join is unambiguous.
const IDENTITY_KEY_SEPARATOR = "\u001F";

// Every Unicode whitespace run - including tab, LF, CR, and NBSP - folds to a
// single U+0020. `\s` with the `u` flag already covers all of them.
const WHITESPACE_RUN = /\s+/gu;

// Applied only AFTER whitespace folding, so tab/LF/CR/VT/FF/NBSP have already
// become spaces and never reach it. What can still survive is what genuinely
// has no business in a display name: NUL, the other C0s, DEL, and C1.
const SURVIVING_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/u;

/**
 * NFC, fold whitespace runs to a single space, trim. Ordered: folding happens
 * before the control-character check, which is why a tab is a space rather
 * than a rejection.
 */
export function normalizeRoleText(raw: string): string {
  return raw.normalize("NFC").replace(WHITESPACE_RUN, " ").trim();
}

function roleTextSchema(maxCodePoints: number, label: string) {
  return (
    z
      .string()
      // `.overwrite()`, not `.transform()`: it normalizes in place while keeping
      // the schema a string. A `.transform()` produces a pipe, and `z.toJSONSchema`
      // -- which the RPC registry runs over every registered contract -- throws
      // outright on transforms ("Transforms cannot be represented in JSON Schema").
      // So a transform here would make these methods unregisterable.
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

// Free text, deliberately no enum: the vocabulary is open (a hard-coded
// Planner/Reviewer/QA enum is explicitly the wrong shape here). Case is
// preserved as the claimant typed it; only the derived identity key folds case.
// Parsing RETURNS the normalized text - callers may send raw input.
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

/**
 * The map key IS the claimId. The refinement makes a key/value mismatch a
 * parse error instead of a silently-valid malformed record - storage derives
 * the id from the key on write, so a mismatch should be unconstructible, and
 * if one ever appears it is corruption worth failing on.
 */
export const roleClaimsSchema = z
  .record(z.uuid(), roleClaimSchema)
  .refine(
    (claims) =>
      Object.entries(claims).every(([key, claim]) => key === claim.claimId),
    { message: "roleClaims key must equal claim.claimId" },
  );

export type RoleClaims = z.infer<typeof roleClaimsSchema>;

/**
 * Case- and whitespace-insensitive identity of a claim, so `Planner` and
 * `planner` are the same claim and near-duplicates get caught. Derived on
 * demand and never persisted, so it cannot drift from the stored text.
 *
 * This is `toLowerCase()` - lowercase normalization, NOT Unicode casefolding.
 * No casefold semantics are claimed.
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

/**
 * The single read projection. Every surface that can show a claim goes
 * through this and adds no filtering of its own.
 *
 * Order matters:
 *
 * 1. **Account first.** An epic can hold several collaborators' agents, and
 *    cross-account role organization is out of scope for v1 - so a foreign
 *    account's claim is dropped before anything else can observe it, whether
 *    that observer is `list`, overlap detection, or prompt text.
 * 2. **Then liveness.** Claims outlive their agents: deleting a TUI agent
 *    cascades nothing, chat deletion runs a different orchestrator, `agent.stop`
 *    is deliberately NOT terminal (a stopped agent keeps its claims), and an
 *    old host deletes agents while blind to this map entirely. No eager cleanup
 *    covers all four, so liveness is resolved on read. Reaping is an
 *    optimization; this filter is the correctness.
 * 3. **Then a deterministic order**, so list output and prompts are stable.
 */
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

/**
 * Locale-INDEPENDENT lexicographic compare.
 *
 * Deliberately not `localeCompare`: UUIDs may carry mixed-case hex, and
 * `localeCompare` collates case by locale (in en-US "B" sorts before "a";
 * by code unit it does not). That would make list order depend on the host's
 * locale, and "deterministic ordering" that varies by machine is not
 * deterministic - two hosts would render the same registry in different orders.
 */
function compareClaimIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
