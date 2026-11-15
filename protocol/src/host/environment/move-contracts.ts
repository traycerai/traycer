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
 * Every answer is value-free: a row names an item and never carries its
 * value, and a row that looks like a key carries only its name. Optional
 * capabilities with `degrade: { kind: "unsupported" }`, off the released
 * floor, like every environment method (`environment/contracts.ts`).
 * `plan@2.0`, `stage`, `start` and `outcome` are defined and not registered:
 * each registers with the host slice that serves it and its first caller.
 */
import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentMoveAttemptOutcomeSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";
import { RETIRED_SAME_NAME_IN_PERSONAL_ROWS } from "@traycer/protocol/host/released-wire-rows";

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
 * Never a value.
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
 * there; `differsMasked` exist in Personal with another value, neither shown.
 *
 * A value that reads like a credential is listed under
 * `staysOnThisComputer`: a secret's value does not move in or out of a
 * computer, so the move leaves it where it is rather than offering to store
 * it. `looksLikeAKey` is retired and still declared, because `cli-v1.5.2` and
 * `cli-v1.5.3` require the key: it is empty on every plan this tree builds
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
 * `sameNameInPersonal` named rows that look like a key whose name Personal
 * already holds as a secret. It is retired with the rest of the key-shaped
 * plane - a value that reads like a credential is listed under
 * `staysOnThisComputer` now and the move offers no choice for it - so no plan
 * this host builds has a row here, and `RETIRED_SAME_NAME_IN_PERSONAL_ROWS`
 * is what fills it. The KEY stays because `cli-v1.5.2` and `cli-v1.5.3`
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

/**
 * The configuration a move or another environment operation addresses: the
 * person's Personal one, or a team's. Nested in a request; the stage
 * evidence carries the same facts flat (`targetKind`).
 */
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
 * What the app read of the person's Personal on the person's own sign-in, for
 * the sheet: each row of every item kind the item routes serve, and whether
 * Personal holds any secret. Personal's environment is `target.environmentId`.
 * The app sends the rows exactly as the route answered them, in the route's
 * order, read for this sheet and never from an older copy, so the sheet and
 * authn's accept see the same Personal as nearly as the two reads allow.
 *
 * `null` when the app could not read Personal; the computer then answers as
 * when the sheet is unavailable. For a team target the app sends `null` and
 * the computer does not read the field.
 *
 * The computer uses this only to draw the sheet ("Already in Personal" and
 * "Different from Personal", and whether Personal's secrets reach this
 * computer), never as a fact for the migrate: authn decides row by row at the
 * accept.
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

/**
 * `@2.0` names the configuration the move is for (`target`). A target that is
 * not the move's own is refused with `E_MOVE_NOT_AWAITING`, as a host whose
 * move is not waiting is. `personal` is what the sheet is drawn against.
 */
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
 * `@1.2`'s answer without `itemChoices`: a `@2.0` host always honours a
 * `stays` choice on a `moves` row, so there is nothing to advertise. A new
 * major has no older sender, so no row list or flag defaults. Reading a plan
 * never stages, never ends an attempt and never touches a staged file.
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
      looksLikeAKey: z.array(environmentMoveRowSchema),
      sameNameInPersonal: z.array(environmentMoveRowSchema),
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

// ── stage, start and outcome ───────────────────────────────────────────────
//
// The move in three calls: `stage` records the person's choices and answers
// the evidence the app sends authn as its acceptance; `start` hands the host
// that acceptance; `outcome` (and `environment.status@1.3`'s `move`) reads
// where the started attempt stands. `plan@2.0`, `stage` and `start` refuse
// with `E_MOVE_NOT_AWAITING` when this computer has no move waiting.

const sha256HexSchema = lazySchema(() => z.string().regex(/^[0-9a-f]{64}$/u));

/** The person's `stays` on one `moves` row, by the row's key. */
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
 * The fields both evidence arms share. `attemptId` is minted by this stage.
 *
 * `keyChoices` is the request's, kept only for a key of a `moves` row whose
 * kind is `variable`, `env_override` or `secret`: one entry per key (the last
 * when a key repeats), ordered by the `moves` rows, every other key dropped.
 * An app that sends only choices on those rows, one per key, in the drawn
 * `moves` order, gets its request back exactly.
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
 * `{ ...evidence, ...authorization }` is authn's acceptance request for that
 * arm, flat, with nothing to rename; `disclosureVersion` appears once. The
 * objects strip unknown keys, so a parsed answer holds exactly these. Staging
 * again ends the earlier attempt, whose id then answers `not_found`; a staged
 * attempt that is never started leaves `environment.status`'s `move` null,
 * survives a restart, and ends at the next stage, at Stop sharing or at the
 * personal purge. Refused with `E_MOVE_NOT_AWAITING` once a start has begun.
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
        disclosureVersion: z.literal(2),
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

/**
 * `start`'s and `outcome`'s answer: the attempt's outcome, or `not_found` for
 * an attempt this host does not hold (never staged, or ended).
 */
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
 * Starts a staged attempt with authn's acceptance and answers at once what
 * `outcome` would. An unknown or ended attempt answers `not_found`; a
 * `planHash` other than the staged one, `needs_person` `plan_hash_mismatch`;
 * a started attempt named with another `acceptanceId`, `needs_person`
 * `move_acceptance_conflict`. The same triple again answers the recorded
 * outcome and restarts nothing. A staged attempt while no move awaits is
 * refused with `E_MOVE_NOT_AWAITING`.
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
