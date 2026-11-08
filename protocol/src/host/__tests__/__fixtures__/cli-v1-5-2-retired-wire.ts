import { z } from "zod";

/**
 * The parts of `cli-v1.5.2`'s wire contract that name a plane this tree
 * retired. `cli-v1.5.3` declares the same shapes. Do not "fix" these to match
 * the current tree: they are a released peer's parser, and the companion test
 * exists to prove this tree still satisfies it.
 *
 * **What is verbatim and what is not.** Every RETIRED field below is copied
 * from the tag as it declares it - name, type and required-ness - because that
 * is what the companion test measures. The surrounding shapes are NOT a
 * verbatim copy of the full released response: only the surfaces
 * `refactor(protocol): no secret enters a sandbox as plain text` cut are
 * reproduced, and where a shape this change never touched would have to come
 * with them it is deliberately left loose. `list@1.2`'s `removed` array is the
 * one such relaxation - the tag types its members, this fixture takes
 * `z.unknown()` - which its own `.default([])` makes safe, since a released
 * peer supplies the default when the key is absent. The effect is intended: a
 * failure here is always about a retired field and never about an untouched
 * shape drifting. So this fixture answers "does a released peer still parse
 * the retired fields", not "is this tree's whole response byte-identical to
 * the tag's".
 *
 * These schemas do not retire when the support floor passes `1.5.3`; see
 * `host/released-wire-rows.ts` for what actually frees them.
 */

/** `cli-v1.5.2`'s `environmentSecretSchema`. */
export const CLI_V152_SECRET_ROW = z.object({
  secretId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1).max(32),
  protocol: z.string().min(1).max(32).nullable(),
  destinations: z.array(z.string().min(1)),
  mode: z.string().min(1).max(32),
  state: z.string().min(1).max(32),
  currentVersionId: z.string().min(1).nullable(),
  revoked: z.boolean(),
  updatedAt: z.number(),
});

/** `cli-v1.5.2`'s `environmentSecretSchemaV12`. */
export const CLI_V152_SECRET_ROW_V12 = CLI_V152_SECRET_ROW.extend({
  variables: z.array(z.string().min(1)),
  providerVariables: z.array(
    z.object({ providerId: z.string().min(1), name: z.string().min(1) }),
  ),
});

/** `cli-v1.5.2`'s `environmentSecretsListResponseSchemaV12`. */
export const CLI_V152_SECRETS_LIST_RESPONSE_V12 = z.object({
  secrets: z.array(CLI_V152_SECRET_ROW_V12),
  removed: z.array(z.unknown()).default([]),
});

/**
 * The two fields `cli-v1.5.2` declares on
 * `environment.secrets.create@1.0`'s and `@1.1`'s request and this tree no
 * longer has a plane for. A released peer sends both, so the host must still
 * read them.
 */
export const CLI_V152_SECRET_CREATE_RETIRED_FIELDS = z.object({
  mode: z.string().min(1).max(32),
  exportPolicy: z.string().min(1).max(32).nullable(),
});

/** `cli-v1.5.2`'s `environmentMovePlanResponseSchema.rows` key set. */
export const CLI_V152_MOVE_PLAN_ROW_GROUPS = [
  "moves",
  "staysOnThisComputer",
  "alreadyInPersonal",
  "differsMasked",
  "looksLikeAKey",
] as const;

/**
 * `cli-v1.5.2`'s `environmentMovePlanResponseSchemaV11.rows` key set: the
 * `@1.0` groups plus `sameNameInPersonal`, which that release adds at `@1.1`
 * and gives `.default([])`.
 */
export const CLI_V152_MOVE_PLAN_ROW_GROUPS_V11 = [
  ...CLI_V152_MOVE_PLAN_ROW_GROUPS,
  "sameNameInPersonal",
] as const;

/** `cli-v1.5.2`'s `environmentMoveKeyChoiceSchema` choices. */
export const CLI_V152_MOVE_KEY_CHOICES = [
  "secret",
  "variable",
  "stays",
] as const;

/** `cli-v1.5.2`'s `guiHarnessSandboxCredentialModeSchema` members. */
export const CLI_V152_SANDBOX_CREDENTIAL_MODES = [
  "placeholder",
  "process-scoped",
  "unsupported",
] as const;
