/**
 * The move: a computer's own settings moving into the person's Personal
 * configuration only on their `Move to Personal`, and stopping sharing them.
 *
 * `environment.move.plan` - the sheet the person reads, row by row.
 * `environment.move.accept` - the person's acceptance of that exact sheet.
 * `environment.move.stage` / `.start` / `.outcome` - the move through authn's
 * acceptance, with `plan@2.0` naming its target.
 * `environment.move.stopPreview` / `environment.move.stop` - what stopping
 * sharing from this computer touches, and stopping it.
 *
 * A row names an item; only a differing row's `detail` names values, both of
 * them, a value that reads like a key as `•••`. Optional capabilities with
 * `degrade: { kind: "unsupported" }`, off the released floor, like every
 * environment method (`environment/contracts.ts`).
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
import {
  environmentItemKindSchema,
  environmentMoveAttemptOutcomeSchema,
  environmentOsSchema,
  environmentOwnershipStatusSchema,
  type EnvironmentOwnershipStatus,
} from "@traycer/protocol/host/environment-schemas";
import { RETIRED_SAME_NAME_IN_PERSONAL_ROWS } from "@traycer/protocol/host/released-wire-rows";
import { TEAM_TRANSFER_DISCLOSURE_VERSION } from "@traycer/protocol/host/environment/team-transfer-disclosure";

const emptyRequestSchema = lazySchema(() => z.object({}));

/**
 * The row kinds a move sheet shows beyond the item kinds
 * (`ENVIRONMENT_ITEM_KINDS`): a tool's own terminal sign-in, a provider
 * profile, an MCP server an earlier build held, and an executable entry.
 * `MoveRow.kind` is an open string, so a newer kind never fails the parse.
 */
export const ENVIRONMENT_MOVE_ROW_EXTRA_KINDS = [
  "terminal_sign_in",
  "profile",
  "mcp_server_held",
  "executable",
] as const;

/**
 * One row of the sheet. `key` is the item's address (a variable's name, a
 * profile's local id); `os` is null for a row with no per-OS axis; `label` is
 * what the sheet calls it and `detail` the one line under it, null when none.
 * Only a `differsMasked` row's `detail` names values.
 */
export const environmentMoveRowSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    os: environmentOsSchema.nullable(),
    label: z.string(),
    detail: z.string().nullable(),
  }),
);
export type EnvironmentMoveRow = z.infer<typeof environmentMoveRowSchema>;

export const environmentMovePlanRequestSchema = emptyRequestSchema;
export type EnvironmentMovePlanRequest = z.infer<
  typeof environmentMovePlanRequestSchema
>;

/**
 * The sheet as this host would move it. `planHash` names exactly these rows
 * and is what an acceptance quotes; `planRevision` counts the plans this host
 * has built, so a client sees the list changed. `hostVersion` is the build
 * that built it and `disclosureVersion` the disclosure the sheet shows.
 *
 * The rows: `moves` travel to Personal; `staysOnThisComputer` never leave it
 * (a terminal sign-in, a held executable); `alreadyInPersonal` are equal
 * there; `differsMasked` exist in Personal with another value, and the row's
 * `detail` names both values, a value that reads like a key as `•••`.
 *
 * `looksLikeAKey` is retired and still declared, because `cli-v1.5.2` and
 * `cli-v1.5.3` require the key. The host sorts every row into the four groups
 * above and has no other, so it is empty on every plan this tree builds
 * (`RETIRED_LOOKS_LIKE_A_KEY_ROWS` in `released-wire-rows.ts`).
 */
export const environmentMovePlanResponseSchema = lazySchema(() =>
  z.object({
    planHash: z.string().min(1),
    planRevision: z.number().int().nonnegative(),
    hostVersion: z.string().min(1).max(64),
    disclosureVersion: z.number().int().nonnegative(),
    rows: z.object({
      moves: z.array(environmentMoveRowSchema),
      staysOnThisComputer: z.array(environmentMoveRowSchema),
      alreadyInPersonal: z.array(environmentMoveRowSchema),
      differsMasked: z.array(environmentMoveRowSchema),
      looksLikeAKey: z.array(environmentMoveRowSchema),
    }),
  }),
);
export type EnvironmentMovePlanResponse = z.infer<
  typeof environmentMovePlanResponseSchema
>;

export const environmentMovePlanV10 = defineRpcContract({
  method: "environment.move.plan",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMovePlanRequestSchema,
  responseSchema: environmentMovePlanResponseSchema,
});

/**
 * `@1.1` adds `sameNameInPersonal` and `guideDiffers`.
 *
 * `sameNameInPersonal` is retired with `looksLikeAKey`: the host sorts every
 * row into the four groups of `@1.0`, so no plan this host builds has a row
 * here, and `RETIRED_SAME_NAME_IN_PERSONAL_ROWS` is what fills it. The KEY
 * stays because `cli-v1.5.2` and `cli-v1.5.3`
 * declare it on this released version. It differs from `looksLikeAKey` in one
 * way worth naming: the released schema gives it `.default([])`, so a PARSER
 * tolerates its absence. That is not a licence to omit it when producing one -
 * a default is a required key in this schema's output type, so the bridge
 * below and the host's plan resolver both fill it.
 *
 * `guideDiffers`: this computer's agent selection guide has the person's
 * edits, which the move never puts over Personal's. Not a row: it counts in
 * no list and has no choice. A `@1.0` answer upgrades with no such rows and
 * `guideDiffers` false.
 */
export const environmentMovePlanResponseSchemaV11 = lazySchema(() =>
  environmentMovePlanResponseSchema.extend({
    rows: environmentMovePlanResponseSchema.shape.rows.extend({
      sameNameInPersonal: z.array(environmentMoveRowSchema).default([]),
    }),
    guideDiffers: z.boolean().default(false),
  }),
);
export type EnvironmentMovePlanResponseV11 = z.infer<
  typeof environmentMovePlanResponseSchemaV11
>;

export const environmentMovePlanV11 = defineRpcContract({
  method: "environment.move.plan",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentMovePlanRequestSchema,
  responseSchema: environmentMovePlanResponseSchemaV11,
});

export const environmentMovePlanUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentMovePlanV10,
  typeof environmentMovePlanV11
>({
  from: environmentMovePlanV10.schemaVersion,
  to: environmentMovePlanV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    rows: {
      ...response.rows,
      sameNameInPersonal: [...RETIRED_SAME_NAME_IN_PERSONAL_ROWS],
    },
    guideDiffers: false,
  }),
});

/**
 * `@1.2` adds `personalHoldsSecrets`: Personal holds at least one key or
 * secret, so the sheet discloses that this computer will be served by them
 * even when this move stores none. The value itself never reaches the
 * computer - a secret is brokered, and a placeholder is what a run holds, as
 * `environmentMoveItemChoiceKey` below says. It
 * also adds `itemChoices`: this host honours a choice on a `moves` row
 * (`environmentMoveItemChoiceKey`). A host that does not drops such a
 * choice and would upload the row, so a client offers them only when this
 * is true. A `@1.1` answer upgrades with both false.
 */
export const environmentMovePlanResponseSchemaV12 = lazySchema(() =>
  environmentMovePlanResponseSchemaV11.extend({
    personalHoldsSecrets: z.boolean().default(false),
    itemChoices: z.boolean().default(false),
  }),
);
export type EnvironmentMovePlanResponseV12 = z.infer<
  typeof environmentMovePlanResponseSchemaV12
>;

export const environmentMovePlanV12 = defineRpcContract({
  method: "environment.move.plan",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentMovePlanRequestSchema,
  responseSchema: environmentMovePlanResponseSchemaV12,
});

export const environmentMovePlanUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentMovePlanV11,
  typeof environmentMovePlanV12
>({
  from: environmentMovePlanV11.schemaVersion,
  to: environmentMovePlanV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    personalHoldsSecrets: false,
    itemChoices: false,
  }),
});

/** The stage evidence carries the same facts flat (`targetKind`). */
export const environmentOperationTargetSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("personal"),
      environmentId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("team"),
      environmentId: z.string().min(1),
      teamId: z.uuid(),
    }),
  ]),
);
export type EnvironmentOperationTarget = z.infer<
  typeof environmentOperationTargetSchema
>;

/**
 * Every row of every item kind the routes serve, as answered, read for this sheet;
 * `null` when Personal could not be read, and always for a team. It only draws the
 * sheet: authn decides each row at the accept.
 */
export const environmentMovePersonalSchema = lazySchema(() =>
  z
    .object({
      items: z
        .array(
          z
            .object({
              kind: environmentItemKindSchema,
              key: z.string().min(1).max(3072),
              os: environmentOsSchema.nullable(),
              value: z.json(),
            })
            .strict(),
        )
        .max(4096),
      holdsSecrets: z.boolean(),
    })
    .strict()
    .nullable(),
);
export type EnvironmentMovePersonal = z.infer<
  typeof environmentMovePersonalSchema
>;

/** A target that is not the move's own is refused with `E_MOVE_NOT_AWAITING`. */
export const environmentMovePlanRequestSchemaV20 = lazySchema(() =>
  z.object({
    target: environmentOperationTargetSchema,
    personal: environmentMovePersonalSchema,
  }),
);
export type EnvironmentMovePlanRequestV20 = z.infer<
  typeof environmentMovePlanRequestSchemaV20
>;

/**
 * No `itemChoices` (a `@2.0` host always honours `stays`) and no retired lists.
 * Reading a plan never stages, ends an attempt or touches a staged file.
 */
export const environmentMovePlanResponseSchemaV20 = lazySchema(() =>
  z.object({
    planHash: z.string().min(1),
    planRevision: z.number().int().nonnegative(),
    // `@1.2`'s field unchanged; the stage evidence's 1..128 is authn's bound,
    // which this one sits inside.
    hostVersion: z.string().min(1).max(64),
    disclosureVersion: z.number().int().nonnegative(),
    rows: z.object({
      moves: z.array(environmentMoveRowSchema),
      staysOnThisComputer: z.array(environmentMoveRowSchema),
      alreadyInPersonal: z.array(environmentMoveRowSchema),
      differsMasked: z.array(environmentMoveRowSchema),
    }),
    guideDiffers: z.boolean(),
    personalHoldsSecrets: z.boolean(),
  }),
);
export type EnvironmentMovePlanResponseV20 = z.infer<
  typeof environmentMovePlanResponseSchemaV20
>;

export const environmentMovePlanV20 = defineRpcContract({
  method: "environment.move.plan",
  schemaVersion: { major: 2, minor: 0 } as const,
  requestSchema: environmentMovePlanRequestSchemaV20,
  responseSchema: environmentMovePlanResponseSchemaV20,
});

/**
 * Never run: `@2.0` has no downgrade, so a host refuses a `@1.x` caller and an app
 * meets a `@1.x`-only host as unsupported.
 */
export const environmentMovePlanUpgradeV12ToV20 = defineUpgradePath<
  typeof environmentMovePlanV12,
  typeof environmentMovePlanV20
>({
  from: environmentMovePlanV12.schemaVersion,
  to: environmentMovePlanV20.schemaVersion,
  upgradeRequest: () => {
    throw new Error(
      "environment.move.plan v1.2 requests cannot be upgraded to v2.0: v1.2 names no target",
    );
  },
  upgradeResponse: () => {
    throw new Error(
      "environment.move.plan v1.2 responses cannot be upgraded to v2.0: no v1.2 request reaches a v2.0 host",
    );
  },
});

/** What every `environmentMoveItemChoiceKey` starts with. */
const ITEM_CHOICE_PREFIX = "item:";

/**
 * The key a choice on one `moves` row is sent under: `item:<kind>:<key>`. A
 * row's kind has no `:`, so the separator after it splits the key back out.
 * Only a host whose plan says `itemChoices` reads it: `stays` leaves the row
 * on this computer only.
 */
export function environmentMoveItemChoiceKey(
  kind: string,
  key: string,
): string {
  return `${ITEM_CHOICE_PREFIX}${kind}:${key}`;
}

/**
 * The person's answer to one `moves` row, under
 * `environmentMoveItemChoiceKey`: leave it on this computer (`stays`). A row
 * with no answer moves as planned, and nothing is stored as a secret from
 * here: a secret's value does not move in or out of a computer.
 *
 * `secret` and `variable` are retired and still accepted, because
 * `cli-v1.5.2` and `cli-v1.5.3` can still send either on this released
 * version: the move resolver refuses both rather than storing a value found
 * on a computer.
 */
export const environmentMoveKeyChoiceSchema = lazySchema(() =>
  z.object({
    key: z.string().min(1),
    choice: z.enum(["secret", "variable", "stays"]),
  }),
);
export type EnvironmentMoveKeyChoice = z.infer<
  typeof environmentMoveKeyChoiceSchema
>;

export const environmentMoveAcceptRequestSchema = lazySchema(() =>
  z.object({
    planHash: z.string().min(1),
    keyChoices: z.array(environmentMoveKeyChoiceSchema),
  }),
);
export type EnvironmentMoveAcceptRequest = z.infer<
  typeof environmentMoveAcceptRequestSchema
>;

/**
 * `accepted` starts the upload: `attemptId` names it and `consentId` the
 * recorded acceptance. `plan_changed` is a `planHash` that is no longer this
 * host's plan, so the sheet reads it again; `not_awaiting` is a host whose
 * move is not waiting for consent.
 */
export const environmentMoveAcceptResponseSchema = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("accepted"),
      attemptId: z.string().min(1),
      consentId: z.string().min(1),
    }),
    z.object({ outcome: z.literal("plan_changed") }),
    z.object({ outcome: z.literal("not_awaiting") }),
  ]),
);
export type EnvironmentMoveAcceptResponse = z.infer<
  typeof environmentMoveAcceptResponseSchema
>;

export const environmentMoveAcceptV10 = defineRpcContract({
  method: "environment.move.accept",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveAcceptRequestSchema,
  responseSchema: environmentMoveAcceptResponseSchema,
});

// `plan@2.0`, `stage` and `start` refuse with `E_MOVE_NOT_AWAITING` when no move is waiting.

const sha256HexSchema = lazySchema(() => z.string().regex(/^[0-9a-f]{64}$/u));

export const environmentMoveStaysChoiceSchema = lazySchema(() =>
  z.object({
    key: z.string().min(1).max(3072),
    choice: z.literal("stays"),
  }),
);
export type EnvironmentMoveStaysChoice = z.infer<
  typeof environmentMoveStaysChoiceSchema
>;

/** At most 4096 choices, and none at all is a valid answer. */
const environmentMoveStaysChoicesSchema = lazySchema(() =>
  z.array(environmentMoveStaysChoiceSchema).max(4096),
);

/** `personal` as on `plan@2.0`: the `moves` rows `keyChoices` is kept against. */
export const environmentMoveStageRequestSchema = lazySchema(() =>
  z.object({
    target: environmentOperationTargetSchema,
    keyChoices: environmentMoveStaysChoicesSchema,
    personal: environmentMovePersonalSchema,
  }),
);
export type EnvironmentMoveStageRequest = z.infer<
  typeof environmentMoveStageRequestSchema
>;

/**
 * `keyChoices` is kept only for keys of `moves` rows of kind `variable`,
 * `env_override` or `secret`: one per key (the last), in `moves` order.
 */
function environmentMoveEvidenceCommonShape() {
  return {
    attemptId: z.uuid(),
    planHash: sha256HexSchema,
    planRevision: z.number().int().nonnegative(),
    hostVersion: z.string().min(1).max(128),
    itemCount: z.number().int().nonnegative(),
    keyChoices: environmentMoveStaysChoicesSchema,
    sourceHostId: z.uuid(),
    sharingGeneration: z.number().int().nonnegative(),
  };
}

/**
 * `{ ...evidence, ...authorization }` is authn's acceptance request, flat. Staging
 * again ends the earlier attempt (`not_found`); an unstarted attempt survives a
 * restart and ends at the next stage, Stop sharing or the purge.
 */
export const environmentMoveStageResponseSchema = lazySchema(() =>
  z.union([
    z.object({
      evidence: z.object({
        ...environmentMoveEvidenceCommonShape(),
        targetKind: z.literal("personal"),
        environmentId: z.string().min(1),
        disclosureVersion: z.number().int().nonnegative(),
      }),
      authorization: z.object({ manifestHash: sha256HexSchema }),
    }),
    z.object({
      evidence: z.object({
        ...environmentMoveEvidenceCommonShape(),
        targetKind: z.literal("team"),
        environmentId: z.string().min(1),
        teamId: z.uuid(),
        disclosureVersion: z.literal(TEAM_TRANSFER_DISCLOSURE_VERSION),
      }),
      authorization: z.object({ disclosureHash: sha256HexSchema }),
    }),
  ]),
);
export type EnvironmentMoveStageResponse = z.infer<
  typeof environmentMoveStageResponseSchema
>;

export const environmentMoveStageV10 = defineRpcContract({
  method: "environment.move.stage",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveStageRequestSchema,
  responseSchema: environmentMoveStageResponseSchema,
});

/** `not_found`: never staged, or ended. */
export const environmentMoveOutcomeAnswerSchema = lazySchema(() =>
  z.discriminatedUnion("state", [
    environmentMoveAttemptOutcomeSchema,
    z.object({ state: z.literal("not_found"), attemptId: z.string().min(1) }),
  ]),
);
export type EnvironmentMoveOutcomeAnswer = z.infer<
  typeof environmentMoveOutcomeAnswerSchema
>;

/**
 * `planHash` is bounded loosely so that one differing from the staged hash
 * reaches the host and is answered `needs_person` `plan_hash_mismatch`.
 */
export const environmentMoveStartRequestSchema = lazySchema(() =>
  z.object({
    attemptId: z.uuid(),
    planHash: z.string().min(1),
    acceptanceId: z.uuid(),
  }),
);
export type EnvironmentMoveStartRequest = z.infer<
  typeof environmentMoveStartRequestSchema
>;

/**
 * Answers at once what `outcome` would. The same triple again answers the recorded
 * outcome and restarts nothing.
 */
export const environmentMoveStartV10 = defineRpcContract({
  method: "environment.move.start",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveStartRequestSchema,
  responseSchema: environmentMoveOutcomeAnswerSchema,
});

/**
 * `attemptId` is bounded loosely, not as a uuid, so that any id the host does
 * not hold reaches it and is answered `not_found`.
 */
export const environmentMoveOutcomeRequestSchema = lazySchema(() =>
  z.object({ attemptId: z.string().min(1) }),
);
export type EnvironmentMoveOutcomeRequest = z.infer<
  typeof environmentMoveOutcomeRequestSchema
>;

/** Kept across a host restart until the next stage. */
export const environmentMoveOutcomeV10 = defineRpcContract({
  method: "environment.move.outcome",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveOutcomeRequestSchema,
  responseSchema: environmentMoveOutcomeAnswerSchema,
});

export const environmentMoveStopPreviewRequestSchema = emptyRequestSchema;
export type EnvironmentMoveStopPreviewRequest = z.infer<
  typeof environmentMoveStopPreviewRequestSchema
>;

/**
 * What stopping sharing touches: `managed` are the entries Traycer placed
 * here; `needsChoice` are the ones the person must decide, because they were
 * `edited_here` by hand or something else `depended_on` them.
 */
export const environmentMoveStopPreviewResponseSchema = lazySchema(() =>
  z.object({
    managed: z.array(environmentMoveRowSchema),
    needsChoice: z.array(
      z.object({
        row: environmentMoveRowSchema,
        reason: z.enum(["edited_here", "depended_on"]),
      }),
    ),
  }),
);
export type EnvironmentMoveStopPreviewResponse = z.infer<
  typeof environmentMoveStopPreviewResponseSchema
>;

export const environmentMoveStopPreviewV10 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchema,
  responseSchema: environmentMoveStopPreviewResponseSchema,
});

/**
 * `@1.1` adds, on each `needsChoice` row, why it needs a choice (`origin`)
 * and what depends on it (`usedBy`):
 *
 * - `from_this_computer`: its value was on this computer before Personal
 *   wrote it there, or the host cannot tell where it came from;
 * - `changed_here`: this computer holds its own value over it;
 * - `depended_on`: other items depend on it, named in `usedBy` (empty for
 *   every other origin).
 *
 * `reason` keeps its `@1.0` meaning for older clients: `edited_here` for the
 * first two origins. A `@1.0` answer upgrades `edited_here` to
 * `changed_here`, which is all a `@1.0` host meant by it, and `depended_on`
 * with no `usedBy`, since it never named them.
 */
export const environmentMoveStopPreviewResponseSchemaV11 = lazySchema(() =>
  environmentMoveStopPreviewResponseSchema.extend({
    needsChoice: z.array(
      z.object({
        row: environmentMoveRowSchema,
        reason: z.enum(["edited_here", "depended_on"]),
        origin: z.enum(["from_this_computer", "changed_here", "depended_on"]),
        usedBy: z.array(environmentMoveRowSchema),
      }),
    ),
  }),
);
export type EnvironmentMoveStopPreviewResponseV11 = z.infer<
  typeof environmentMoveStopPreviewResponseSchemaV11
>;

export const environmentMoveStopPreviewV11 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchema,
  responseSchema: environmentMoveStopPreviewResponseSchemaV11,
});

export const environmentMoveStopPreviewUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentMoveStopPreviewV10,
  typeof environmentMoveStopPreviewV11
>({
  from: environmentMoveStopPreviewV10.schemaVersion,
  to: environmentMoveStopPreviewV11.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    needsChoice: response.needsChoice.map((entry) => ({
      ...entry,
      origin:
        entry.reason === "edited_here"
          ? ("changed_here" as const)
          : ("depended_on" as const),
      usedBy: [],
    })),
  }),
});

/**
 * Two folders of one account stay separate entries; credential kind decides whether sign-in is
 * offered.
 */
export const environmentMovePersonalProfileSchemaV12 = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1),
    label: z.string(),
    signIn: z.enum(["offered", "not-needed"]),
  }),
);
export type EnvironmentMovePersonalProfileV12 = z.infer<
  typeof environmentMovePersonalProfileSchemaV12
>;

/** `@1.3`: `shared` is a folder whose sign-in the environment holds; a skipped one leaves this computer. */
export const environmentMovePersonalProfileSchema = lazySchema(() =>
  environmentMovePersonalProfileSchemaV12.extend({ shared: z.boolean() }),
);
export type EnvironmentMovePersonalProfile = z.infer<
  typeof environmentMovePersonalProfileSchema
>;

export const environmentMoveStopPreviewRequestSchemaV12 = lazySchema(() =>
  z.object({
    profileMode: z.literal("keep-personal").nullable().default(null),
  }),
);
export type EnvironmentMoveStopPreviewRequestV12 = z.infer<
  typeof environmentMoveStopPreviewRequestSchemaV12
>;

/** Absent/null is a legacy preview; an empty array is active with no folders. */
export const environmentMoveStopPreviewResponseSchemaV12 = lazySchema(() =>
  environmentMoveStopPreviewResponseSchemaV11.extend({
    personalProfiles: z
      .array(environmentMovePersonalProfileSchemaV12)
      .nullable()
      .optional(),
  }),
);
export type EnvironmentMoveStopPreviewResponseV12 = z.infer<
  typeof environmentMoveStopPreviewResponseSchemaV12
>;

export const environmentMoveStopPreviewResponseSchemaV13 = lazySchema(() =>
  environmentMoveStopPreviewResponseSchemaV11.extend({
    personalProfiles: z
      .array(environmentMovePersonalProfileSchema)
      .nullable()
      .optional(),
  }),
);
export type EnvironmentMoveStopPreviewResponseV13 = z.infer<
  typeof environmentMoveStopPreviewResponseSchemaV13
>;

export const environmentMoveStopPreviewV12 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchemaV12,
  responseSchema: environmentMoveStopPreviewResponseSchemaV12,
});

export const environmentMoveStopPreviewUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentMoveStopPreviewV11,
  typeof environmentMoveStopPreviewV12
>({
  from: { major: 1, minor: 1 },
  to: { major: 1, minor: 2 },
  upgradeRequest: (request) => ({ ...request, profileMode: null }),
  upgradeResponse: (response) => ({ ...response, personalProfiles: null }),
});

export const environmentMoveStopPreviewV13 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchemaV12,
  responseSchema: environmentMoveStopPreviewResponseSchemaV13,
});

export const environmentMoveStopPreviewUpgradeV12ToV13 = defineUpgradePath<
  typeof environmentMoveStopPreviewV12,
  typeof environmentMoveStopPreviewV13
>({
  from: { major: 1, minor: 2 },
  to: { major: 1, minor: 3 },
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    personalProfiles:
      response.personalProfiles === null ||
      response.personalProfiles === undefined
        ? response.personalProfiles
        : response.personalProfiles.map((row) => ({ ...row, shared: false })),
  }),
});

/**
 * The digest identifies the sheet that Confirm would apply. If a
 * keep-personal preview returns `personalProfiles: null`, it shows the plain
 * sheet and carries the plain Stop's digest. Older previews upgrade to null.
 */
export const environmentMoveStopPreviewResponseSchemaV14 = lazySchema(() =>
  environmentMoveStopPreviewResponseSchemaV13.extend({
    sheetDigest: sha256HexSchema.nullable(),
  }),
);
export type EnvironmentMoveStopPreviewResponseV14 = z.infer<
  typeof environmentMoveStopPreviewResponseSchemaV14
>;

export const environmentMoveStopPreviewV14 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 4 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchemaV12,
  responseSchema: environmentMoveStopPreviewResponseSchemaV14,
});

export const environmentMoveStopPreviewUpgradeV13ToV14 = defineUpgradePath<
  typeof environmentMoveStopPreviewV13,
  typeof environmentMoveStopPreviewV14
>({
  from: environmentMoveStopPreviewV13.schemaVersion,
  to: environmentMoveStopPreviewV14.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({ ...response, sheetDigest: null }),
});

export type EnvironmentMoveStopPersonalBinding = NonNullable<
  EnvironmentOwnershipStatus["personalBinding"]
>;

export function matchesStopPersonalBinding(
  expected: EnvironmentMoveStopPersonalBinding,
  current: EnvironmentMoveStopPersonalBinding | null,
): boolean {
  return (
    current !== null &&
    current.environmentId === expected.environmentId &&
    current.bindingGeneration === expected.bindingGeneration &&
    current.sharingGeneration === expected.sharingGeneration
  );
}

export const environmentMoveStopPreviewResponseSchemaV15 = lazySchema(() =>
  environmentMoveStopPreviewResponseSchemaV14.extend({
    ownershipUnreadable: z.boolean(),
    personalBinding: environmentOwnershipStatusSchema.shape.personalBinding,
  }),
);
export type EnvironmentMoveStopPreviewResponseV15 = z.infer<
  typeof environmentMoveStopPreviewResponseSchemaV15
>;

const environmentMoveStopPreviewRequestSchemaV15 = lazySchema(() =>
  environmentMoveStopPreviewRequestSchemaV12.extend({
    expectedPersonalBinding:
      environmentOwnershipStatusSchema.shape.personalBinding,
  }),
);

export const environmentMoveStopPreviewV15 = defineRpcContract({
  method: "environment.move.stopPreview",
  schemaVersion: { major: 1, minor: 5 } as const,
  requestSchema: environmentMoveStopPreviewRequestSchemaV15,
  responseSchema: environmentMoveStopPreviewResponseSchemaV15,
});

export const environmentMoveStopPreviewUpgradeV14ToV15 = defineUpgradePath<
  typeof environmentMoveStopPreviewV14,
  typeof environmentMoveStopPreviewV15
>({
  from: environmentMoveStopPreviewV14.schemaVersion,
  to: environmentMoveStopPreviewV15.schemaVersion,
  upgradeRequest: (request) => ({ ...request, expectedPersonalBinding: null }),
  upgradeResponse: (response) => ({
    ...response,
    ownershipUnreadable: false,
    personalBinding: null,
  }),
});

/**
 * One `needsChoice` row's answer, by the row's `kind` and `key`: a key alone
 * does not name a row, since a variable and a skill can share one.
 */
export const environmentMoveStopChoiceSchema = lazySchema(() =>
  z.object({
    kind: environmentItemKindSchema,
    key: z.string().min(1),
    choice: z.enum(["keep_locally", "remove_from_this_computer", "resolve"]),
  }),
);
export type EnvironmentMoveStopChoice = z.infer<
  typeof environmentMoveStopChoiceSchema
>;

export const environmentMoveStopRequestSchema = lazySchema(() =>
  z.object({ choices: z.array(environmentMoveStopChoiceSchema) }),
);
export type EnvironmentMoveStopRequest = z.infer<
  typeof environmentMoveStopRequestSchema
>;

/**
 * `stopped` once this computer no longer shares; `choices_missing` while a
 * `needsChoice` row has no answer; `not_shared` for a computer that shares
 * nothing.
 */
export const environmentMoveStopResponseSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(["stopped", "choices_missing", "not_shared"]),
  }),
);
export type EnvironmentMoveStopResponse = z.infer<
  typeof environmentMoveStopResponseSchema
>;

export const environmentMoveStopV10 = defineRpcContract({
  method: "environment.move.stop",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: environmentMoveStopRequestSchema,
  responseSchema: environmentMoveStopResponseSchema,
});

/**
 * A choice for an exact folder. `admissionId` is the opaque startLogin
 * handle of its held leave sign-in, not the destination folder's id.
 */
export const environmentMoveProfileSignInChoiceSchemaV11 = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1),
    signIn: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("skip") }),
      z.object({
        kind: z.literal("signed-in"),
        admissionId: z.string().min(1),
      }),
    ]),
  }),
);
export type EnvironmentMoveProfileSignInChoiceV11 = z.infer<
  typeof environmentMoveProfileSignInChoiceSchemaV11
>;

/**
 * `@1.2`: `skip` is a pressed Skip, which removes a shared folder from this
 * computer; `untouched` is an offered folder nobody answered, kept as it is.
 */
export const environmentMoveProfileSignInChoiceSchema = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1),
    signIn: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("skip") }),
      z.object({ kind: z.literal("untouched") }),
      z.object({
        kind: z.literal("signed-in"),
        admissionId: z.string().min(1),
      }),
    ]),
  }),
);
export type EnvironmentMoveProfileSignInChoice = z.infer<
  typeof environmentMoveProfileSignInChoiceSchema
>;

export const environmentMoveStopRequestSchemaV11 = lazySchema(() =>
  environmentMoveStopRequestSchema.extend({
    profileMode: z.literal("keep-personal").nullable().default(null),
    profileSignIns: z
      .array(environmentMoveProfileSignInChoiceSchemaV11)
      .default([]),
  }),
);
export type EnvironmentMoveStopRequestV11 = z.infer<
  typeof environmentMoveStopRequestSchemaV11
>;

export const environmentMoveStopRequestSchemaV12 = lazySchema(() =>
  environmentMoveStopRequestSchemaV11.extend({
    profileSignIns: z
      .array(environmentMoveProfileSignInChoiceSchema)
      .default([]),
  }),
);
export type EnvironmentMoveStopRequestV12 = z.infer<
  typeof environmentMoveStopRequestSchemaV12
>;

export const environmentMoveProfileResultSchema = lazySchema(() =>
  z.object({
    providerId: providerIdSchema,
    profileId: z.string().min(1),
    signIn: z.enum([
      "not-needed",
      "skipped",
      "installed",
      "installation-pending",
      "sign-in-unavailable",
      "installation-failed",
    ]),
  }),
);
export type EnvironmentMoveProfileResult = z.infer<
  typeof environmentMoveProfileResultSchema
>;

/** Absent/null promises no per-folder result; only an active stop returns an array. */
export const environmentMoveStopResponseSchemaV11 = lazySchema(() =>
  environmentMoveStopResponseSchema.extend({
    profileResults: z
      .array(environmentMoveProfileResultSchema)
      .nullable()
      .optional(),
  }),
);
export type EnvironmentMoveStopResponseV11 = z.infer<
  typeof environmentMoveStopResponseSchemaV11
>;

export const environmentMoveStopV11 = defineRpcContract({
  method: "environment.move.stop",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: environmentMoveStopRequestSchemaV11,
  responseSchema: environmentMoveStopResponseSchemaV11,
});

export const environmentMoveStopUpgradeV10ToV11 = defineUpgradePath<
  typeof environmentMoveStopV10,
  typeof environmentMoveStopV11
>({
  from: { major: 1, minor: 0 },
  to: { major: 1, minor: 1 },
  upgradeRequest: (request) => ({
    ...request,
    profileMode: null,
    profileSignIns: [],
  }),
  upgradeResponse: (response) => ({ ...response, profileResults: null }),
});

export const environmentMoveStopV12 = defineRpcContract({
  method: "environment.move.stop",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: environmentMoveStopRequestSchemaV12,
  responseSchema: environmentMoveStopResponseSchemaV11,
});

/** A `@1.1` client sent `skip` for answered and unanswered folders alike, and its skip never removed one. */
export const environmentMoveStopUpgradeV11ToV12 = defineUpgradePath<
  typeof environmentMoveStopV11,
  typeof environmentMoveStopV12
>({
  from: { major: 1, minor: 1 },
  to: { major: 1, minor: 2 },
  upgradeRequest: (request) => ({
    ...request,
    profileSignIns: request.profileSignIns.map((choice) =>
      choice.signIn.kind === "skip"
        ? { ...choice, signIn: { kind: "untouched" as const } }
        : choice,
    ),
  }),
  upgradeResponse: (response) => response,
});

const environmentMoveStopRequestSchemaV13 = lazySchema(() =>
  environmentMoveStopRequestSchemaV12.extend({
    sheetDigest: sha256HexSchema.nullable().default(null),
  }),
);
export type EnvironmentMoveStopRequestV13 = z.infer<
  typeof environmentMoveStopRequestSchemaV13
>;

const environmentMoveStopResponseSchemaV13 = lazySchema(() =>
  z.discriminatedUnion("outcome", [
    environmentMoveStopResponseSchemaV11,
    z.object({
      outcome: z.literal("sheet_changed"),
      preview: environmentMoveStopPreviewResponseSchemaV14.extend({
        sheetDigest: sha256HexSchema,
      }),
    }),
  ]),
);
export type EnvironmentMoveStopResponseV13 = z.infer<
  typeof environmentMoveStopResponseSchemaV13
>;

export const environmentMoveStopV13 = defineRpcContract({
  method: "environment.move.stop",
  schemaVersion: { major: 1, minor: 3 } as const,
  requestSchema: environmentMoveStopRequestSchemaV13,
  responseSchema: environmentMoveStopResponseSchemaV13,
});

export const environmentMoveStopUpgradeV12ToV13 = defineUpgradePath<
  typeof environmentMoveStopV12,
  typeof environmentMoveStopV13
>({
  from: environmentMoveStopV12.schemaVersion,
  to: environmentMoveStopV13.schemaVersion,
  upgradeRequest: (request) => ({ ...request, sheetDigest: null }),
  upgradeResponse: (response) => response,
});

const environmentMoveStopRequestSchemaV14 = lazySchema(() =>
  environmentMoveStopRequestSchemaV13.extend({
    requireUnreadableOwnership: z.boolean(),
    expectedPersonalBinding:
      environmentOwnershipStatusSchema.shape.personalBinding,
  }),
);
export type EnvironmentMoveStopRequestV14 = z.infer<
  typeof environmentMoveStopRequestSchemaV14
>;

export const environmentMoveStopV14 = defineRpcContract({
  method: "environment.move.stop",
  schemaVersion: { major: 1, minor: 4 } as const,
  requestSchema: environmentMoveStopRequestSchemaV14,
  responseSchema: environmentMoveStopResponseSchemaV13,
});

export const environmentMoveStopUpgradeV13ToV14 = defineUpgradePath<
  typeof environmentMoveStopV13,
  typeof environmentMoveStopV14
>({
  from: environmentMoveStopV13.schemaVersion,
  to: environmentMoveStopV14.schemaVersion,
  upgradeRequest: (request) => ({
    ...request,
    requireUnreadableOwnership: false,
    expectedPersonalBinding: null,
  }),
  upgradeResponse: (response) => response,
});
