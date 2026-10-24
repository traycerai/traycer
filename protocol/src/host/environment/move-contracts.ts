/**
 * The move: a computer's own settings moving into the person's Personal
 * configuration only on their `Move to Personal`, and stopping sharing them.
 *
 * `environment.move.plan` - the sheet the person reads, row by row.
 * `environment.move.accept` - the person's acceptance of that exact sheet.
 * `environment.move.stopPreview` / `environment.move.stop` - what stopping
 * sharing from this computer touches, and stopping it.
 *
 * Every answer is value-free: a row names an item and never carries its
 * value, and a row that looks like a key carries only its name. Optional
 * capabilities with `degrade: { kind: "unsupported" }`, off the released
 * floor, like every environment method (`environment/contracts.ts`).
 */
import { z } from "zod";
import { defineRpcContract } from "@traycer/protocol/framework/index";
import { lazySchema } from "@traycer/protocol/framework/lazy-schema";
import {
  environmentItemKindSchema,
  environmentOsSchema,
} from "@traycer/protocol/host/environment-schemas";

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
 * there; `differsMasked` exist in Personal with another value, neither shown;
 * `looksLikeAKey` are values that read like a credential, each answered by a
 * key choice.
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
 * The person's answer to one `looksLikeAKey` row, by its key: move it as a
 * `secret`, move it as a `variable`, or leave it on this computer (`stays`).
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
