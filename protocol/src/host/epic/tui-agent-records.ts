import { z } from "zod";
import {
  defineRpcContract,
  defineUpgradePath,
} from "@traycer/protocol/framework/index";
import { agentModeSchema } from "@traycer/protocol/persistence/epic/schemas";
import { worktreeBindingWorkspaceModeSchema } from "@traycer/protocol/host/worktree-schemas";

/**
 * `epic.listTuiAgents@1.0` - the terminal-agent RECORD read, the TUI sibling of `epic.listChatRecords`.
 * Registered `degrade: { kind: "unsupported" }` and never on the released floor.
 */
export const listTuiAgentsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListTuiAgentsRequest = z.infer<typeof listTuiAgentsRequestSchema>;

/** One terminal agent, as the serving host's registry knows it. */
export const tuiAgentRecordSummarySchema = z.object({
  tuiAgentId: z.string().min(1),
  /** IDENTITY-BEARING, as on the chat row - never render, always key. */
  ownerUserId: z.string().min(1),
  /**
   * The BINDING host - the record is bound to it for life. Non-empty like the
   * owner: a row with no binding could not be addressed by any affordance.
   */
  hostId: z.string().min(1),
  /**
   * The harness discriminator, an OPEN string on the wire so a newer host's vendor still parses; clients narrow through their own harness catalog and drop what they cannot dispatch.
   */
  harnessId: z.string().min(1),
  harnessSessionId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  archivedAt: z.number().int().nonnegative().nullable(),
  workspaceFolders: z.array(z.string()),
  workspaceMode: worktreeBindingWorkspaceModeSchema.nullable(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  agentMode: agentModeSchema,
  profileId: z.string().nullable(),
  terminalAgentArgs: z.string().nullable(),
  terminalShellCommand: z.string().nullable(),
  terminalShellArgs: z.array(z.string()).nullable(),
  revision: z.number().int().nonnegative(),
});
export type TuiAgentRecordSummary = z.infer<typeof tuiAgentRecordSummarySchema>;

export const listTuiAgentsResponseSchema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummarySchema),
});
export type ListTuiAgentsResponse = z.infer<typeof listTuiAgentsResponseSchema>;

export const epicListTuiAgentsV10 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 0 } as const,
  requestSchema: listTuiAgentsRequestSchema,
  responseSchema: listTuiAgentsResponseSchema,
});

/**
 * The `@1.1` row: the `@1.0` summary plus its ORIGIN.
 * Serving the union without the marker would fix the disappearance and silently introduce that mis-route, which is the worse bug of the two - it fails on write instead of on render.
 */
export const tuiAgentRecordSummaryV11Schema =
  tuiAgentRecordSummarySchema.extend({
    docResident: z.boolean(),
  });
export type TuiAgentRecordSummaryV11 = z.infer<
  typeof tuiAgentRecordSummaryV11Schema
>;

export const listTuiAgentsResponseV11Schema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummaryV11Schema),
});
export type ListTuiAgentsResponseV11 = z.infer<
  typeof listTuiAgentsResponseV11Schema
>;

/**
 * The `@1.1` request: the `@1.0` request plus the caller's own answer to the only question that decides what this method should serve.
 */
export const listTuiAgentsRequestV11Schema = listTuiAgentsRequestSchema.extend({
  hasDocReplica: z.boolean(),
});
export type ListTuiAgentsRequestV11 = z.infer<
  typeof listTuiAgentsRequestV11Schema
>;

export const epicListTuiAgentsV11 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 1 } as const,
  requestSchema: listTuiAgentsRequestV11Schema,
  responseSchema: listTuiAgentsResponseV11Schema,
});

/**
 * Both fills are FACTS about a `@1.0` peer, not defaults - which is what makes the upgraded value safe to act on rather than merely well-typed.
 * It therefore holds a doc replica, and the host must serve it registry rows only.
 */
export const epicListTuiAgentsUpgradeV10ToV11 = defineUpgradePath<
  typeof epicListTuiAgentsV10,
  typeof epicListTuiAgentsV11
>({
  from: epicListTuiAgentsV10.schemaVersion,
  to: epicListTuiAgentsV11.schemaVersion,
  upgradeRequest: (request) => ({ ...request, hasDocReplica: true }),
  upgradeResponse: (response) => ({
    ...response,
    tuiAgents: response.tuiAgents.map((row) => ({
      ...row,
      docResident: false,
    })),
  }),
});

/**
 * WHERE a served row came from, and therefore WHAT it can honestly carry.
 * Two independent booleans would admit combinations that cannot exist (`docResident && cloud`) and would leave the shape of a row derivable only by inspecting its keys.
 */
export const tuiAgentRecordOriginSchema = z.enum([
  "registry",
  "doc",
  "cloud",
] as const);
export type TuiAgentRecordOrigin = z.infer<typeof tuiAgentRecordOriginSchema>;

/** The `@1.1` row, marked as the serving host's own registry row. */
export const tuiAgentRecordSummaryV12RegistrySchema =
  tuiAgentRecordSummaryV11Schema.extend({
    origin: z.literal("registry"),
  });
export type TuiAgentRecordSummaryV12Registry = z.infer<
  typeof tuiAgentRecordSummaryV12RegistrySchema
>;

/** The `@1.1` row, marked as the doc map's frozen copy. `docResident` is `true`. */
export const tuiAgentRecordSummaryV12DocSchema =
  tuiAgentRecordSummaryV11Schema.extend({
    origin: z.literal("doc"),
  });
export type TuiAgentRecordSummaryV12Doc = z.infer<
  typeof tuiAgentRecordSummaryV12DocSchema
>;

/**
 * A terminal agent owned by ANOTHER of the viewer's hosts, as this host's record inbox replicated it - the phase-2 roster row.
 * A client that cannot name the harness renders the row without a harness mark rather than dropping the agent from the roster.
 */
export const tuiAgentRecordSummaryV12CloudSchema = z.object({
  origin: z.literal("cloud"),
  tuiAgentId: z.string().min(1),
  /** IDENTITY-BEARING, as on every other row - never render, always key. */
  ownerUserId: z.string().min(1),
  /** The BINDING host: the machine this agent lives on and is addressed through. */
  hostId: z.string().min(1),
  /** From the cloud row's `runSettingsSummary`; see the header. */
  harnessId: z.string().min(1).nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archived: z.boolean(),
  revision: z.number().int().nonnegative(),
});
export type TuiAgentRecordSummaryV12Cloud = z.infer<
  typeof tuiAgentRecordSummaryV12CloudSchema
>;

/** The `@1.2` row: the three populations a host can serve, discriminated. */
export const tuiAgentRecordSummaryV12Schema = z.discriminatedUnion("origin", [
  tuiAgentRecordSummaryV12RegistrySchema,
  tuiAgentRecordSummaryV12DocSchema,
  tuiAgentRecordSummaryV12CloudSchema,
]);
export type TuiAgentRecordSummaryV12 = z.infer<
  typeof tuiAgentRecordSummaryV12Schema
>;

export const listTuiAgentsResponseV12Schema = z.object({
  tuiAgents: z.array(tuiAgentRecordSummaryV12Schema),
});
export type ListTuiAgentsResponseV12 = z.infer<
  typeof listTuiAgentsResponseV12Schema
>;

/**
 * The `@1.2` request is the `@1.1` request unchanged.
 * Aliased rather than re-declared so the two versions cannot drift.
 */
export const listTuiAgentsRequestV12Schema = listTuiAgentsRequestV11Schema;
export type ListTuiAgentsRequestV12 = ListTuiAgentsRequestV11;

export const epicListTuiAgentsV12 = defineRpcContract({
  method: "epic.listTuiAgents",
  schemaVersion: { major: 1, minor: 2 } as const,
  requestSchema: listTuiAgentsRequestV12Schema,
  responseSchema: listTuiAgentsResponseV12Schema,
});

/**
 * `origin` is DERIVED from `docResident`, and that is a fact about the `@1.1` peer rather than a default chosen for it.
 * It cannot serve a cloud replica: the inbox arm that produces one is phase 2, and it ships in the same host build as this minor.
 */
export const epicListTuiAgentsUpgradeV11ToV12 = defineUpgradePath<
  typeof epicListTuiAgentsV11,
  typeof epicListTuiAgentsV12
>({
  from: epicListTuiAgentsV11.schemaVersion,
  to: epicListTuiAgentsV12.schemaVersion,
  upgradeRequest: (request) => request,
  upgradeResponse: (response) => ({
    ...response,
    tuiAgents: response.tuiAgents.map((row) =>
      row.docResident
        ? { ...row, origin: "doc" as const }
        : { ...row, origin: "registry" as const },
    ),
  }),
});
